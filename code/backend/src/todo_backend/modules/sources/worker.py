"""Application-lifetime read scheduler with persisted claims."""

import asyncio
import logging
import time
from contextlib import suppress

from sqlalchemy import select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.feishu_cli.reader import ReadFailure, read_source
from todo_backend.modules.memory.invalidation import invalidate_changed_evidence
from todo_backend.modules.memory.service import lock_account
from todo_backend.modules.sources.discarding import filtered_content
from todo_backend.modules.sources.follow import send_due
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources


def poll_sources(engine: Engine) -> None:
    """Claim and read at most one source, discard stale in-flight results."""
    now = int(time.time())
    with engine.begin() as conn:
        row = (
            conn.execute(
                select(sources)
                .where(
                    sources.c.enabled.is_(True),
                    sources.c.removed.is_(False),
                    sources.c.next_run <= now,
                )
                .limit(1)
            )
            .mappings()
            .first()
        )
        if row is None:
            return
        changed = conn.execute(
            update(sources)
            .where(
                sources.c.id == row["id"],
                sources.c.version == row["version"],
                sources.c.next_run == row["next_run"],
                sources.c.enabled.is_(True),
            )
            .values(next_run=now + row["interval"])
        )
        if changed.rowcount != 1:
            return
    try:
        content = read_source(row["kind"], row["address"])
        values: dict[str, object] = {
            "content": content,
            "last_run": now,
            "status": "读取完成；等待识别" if row["ai_consent"] else "读取完成；未授权 AI 分析",
        }
    except ReadFailure as exc:
        values = {"status": str(exc), "enabled": False, "version": row["version"] + 1}
    with engine.begin() as conn:
        # Maintain existing proofs even when new memory generation is switched off.
        lock_account(conn, str(row["account"]))
        if row["kind"] == "chat" and "content" in values:
            values["content"] = filtered_content(
                conn, str(row["account"]), str(row["address"]), str(values["content"])
            )
        saved = conn.execute(
            update(sources)
            .where(
                sources.c.id == row["id"],
                sources.c.version == row["version"],
                sources.c.content == row["content"],
                sources.c.next_run == now + row["interval"],
                sources.c.enabled.is_(True),
                sources.c.removed.is_(False),
            )
            .values(**values)
        )
        if saved.rowcount != 1:
            return
        if "content" in values:
            invalidate_changed_evidence(conn, row, str(values["content"]))

    analyze_source(engine, str(row["id"]))


async def run_reader(engine: Engine, stop: asyncio.Event) -> None:
    """Poll until shutdown; missing migrations never trigger implicit creation."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(poll_sources, engine)
            await asyncio.to_thread(send_due, engine)
        except SQLAlchemyError:
            logging.getLogger(__name__).warning("来源存储暂不可用，请检查迁移状态")
        with suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=5)
