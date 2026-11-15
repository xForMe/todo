"""Explicit recovery of processed messages without matching historical evidence."""

import json
import time

from sqlalchemy import select, update
from sqlalchemy.engine import Engine

from todo_backend.modules.sources.discarding import discard_key
from todo_backend.modules.sources.message_receipts import chat_messages, receipts
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.service import WorkError


def unmatched_messages(engine: Engine, account: str) -> list[dict[str, object]]:
    """Inspect only stored current pages; evidence matching is deliberately conservative."""
    result: list[dict[str, object]] = []
    with engine.connect() as conn:
        rows = (
            conn.execute(
                select(sources).where(
                    sources.c.account == account,
                    sources.c.kind == "chat",
                    sources.c.removed.is_(False),
                )
            )
            .mappings()
            .all()
        )
        for src in rows:
            history = (
                conn.execute(
                    select(suggestions.c.body)
                    .join(sources, sources.c.id == suggestions.c.source_id)
                    .where(
                        suggestions.c.account == account,
                        sources.c.account == account,
                        sources.c.address == src["address"],
                    )
                )
                .scalars()
                .all()
            )
            evidence = [json.loads(body)["evidence"] for body in history]
            done = set(
                conn.execute(
                    select(receipts.c.message_id).where(
                        receipts.c.account == account, receipts.c.address == src["address"]
                    )
                ).scalars()
            )
            for mid, raw in chat_messages(src["content"]).items():
                if mid.startswith("legacy:") or discard_key(mid) in done:
                    continue
                message = json.loads(raw)
                content = message.get("content", "")
                if not isinstance(content, str) or not content.strip() or message.get("deleted"):
                    continue
                if any(part and (part in raw or content in part) for part in evidence):
                    continue
                result.append(
                    {
                        "source_id": src["id"],
                        "message_id": mid,
                        "version": src["version"],
                        "content": content,
                        "processed": mid in done,
                        "can_retry": bool(
                            src["enabled"]
                            and src["ai_consent"]
                            and mid in done
                            and src["status"] != "单条消息重新识别中"
                        ),
                    }
                )
    return result


def retry_message(engine: Engine, account: str, sid: str, mid: str, version: int) -> str:
    """Claim a single explicit attempt, retaining receipts and all historical suggestions."""
    candidate = next(
        (
            r
            for r in unmatched_messages(engine, account)
            if r["source_id"] == sid and r["message_id"] == mid
        ),
        None,
    )
    if candidate is None:
        raise WorkError(409, "未找到待核对消息，或已有对应建议，请刷新")
    if not candidate["can_retry"] or candidate["version"] != version:
        raise WorkError(409, "来源未启用、未授权、尚未处理或版本已变化")
    with engine.begin() as conn:
        changed = conn.execute(
            update(sources)
            .where(
                sources.c.id == sid,
                sources.c.account == account,
                sources.c.version == version,
                sources.c.enabled.is_(True),
                sources.c.ai_consent.is_(True),
                sources.c.removed.is_(False),
            )
            .values(
                version=version + 1, next_run=int(time.time()) + 300, status="单条消息重新识别中"
            )
        )
        if changed.rowcount != 1:
            raise WorkError(409, "来源已变化，请刷新核对")
    # A background pass may have committed between inspection and our version claim.
    if not any(
        r["source_id"] == sid and r["message_id"] == mid
        for r in unmatched_messages(engine, account)
    ):
        with engine.begin() as conn:
            conn.execute(
                update(sources)
                .where(sources.c.id == sid, sources.c.version == version + 1)
                .values(status="已找到对应建议")
            )
        return "已找到对应建议，请核对"
    analyze_source(engine, sid, mid, version + 1)
    with engine.connect() as conn:
        return str(
            conn.execute(
                select(sources.c.status).where(sources.c.id == sid, sources.c.account == account)
            ).scalar_one()
        )
