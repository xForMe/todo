"""Explicit indexing attempts with revision guards and no automatic external retries."""

import json
import time

from sqlalchemy import insert, select, text, update
from sqlalchemy.engine import Engine

from todo_backend.integrations.ai.embeddings import EmbeddingError, configuration, embed
from todo_backend.modules.memory.repository import jobs
from todo_backend.modules.memory.schemas import CardOutput, IndexInput
from todo_backend.modules.memory.service import enabled, lock_account, read_card, require_enabled
from todo_backend.modules.work.service import WorkError


def card_text(card: CardOutput) -> str:
    """Encode only the confirmed module card, never its event history."""
    return card.path + "\n" + card.description + "\n" + "\n".join(card.aliases)


def index_card(engine: Engine, account: str, module_id: str, data: IndexInput) -> str:
    """Index a reviewed revision once; an interrupted attempt remains unknown."""
    require_enabled()
    try:
        config = configuration()
    except EmbeddingError as exc:
        raise WorkError(409, str(exc)) from exc
    op = str(data.operation_id)
    with engine.begin() as conn:
        lock_account(conn, account)
        card = read_card(conn, account, module_id)
        prior = (
            conn.execute(select(jobs).where(jobs.c.account == account, jobs.c.id == op))
            .mappings()
            .first()
        )
        if prior:
            if (prior["module_id"], prior["revision"], prior["profile"]) != (
                module_id,
                data.expected_version,
                config.profile,
            ):
                raise WorkError(409, "索引操作标识冲突")
            return str(prior["state"])
        if not card.usable or card.version != data.expected_version:
            raise WorkError(409, "模块记忆已变化，请先重新核对")
        previous = (
            conn.execute(
                select(jobs).where(jobs.c.account == account, jobs.c.module_id == module_id)
            )
            .mappings()
            .all()
        )
        if any(
            row["state"] == "running" and int(row["started"]) + 90 > time.time() for row in previous
        ):
            raise WorkError(409, "索引正在处理，请先核对结果")
        if len(previous) >= 10:
            raise WorkError(409, "本版本索引尝试已达上限，请核对配置后重新确认记忆")
        # An expired lease authorizes no retry: only this explicit new operation can call again.
        conn.execute(
            update(jobs)
            .where(
                jobs.c.account == account, jobs.c.module_id == module_id, jobs.c.state == "running"
            )
            .values(state="unknown")
        )
        conn.execute(
            insert(jobs).values(
                account=account,
                id=op,
                module_id=module_id,
                revision=card.version,
                profile=config.profile,
                state="running",
                started=int(time.time()),
            )
        )
    try:
        vector = embed(card_text(card), config)
    except EmbeddingError as exc:
        with engine.begin() as conn:
            conn.execute(
                update(jobs)
                .where(jobs.c.account == account, jobs.c.id == op, jobs.c.state == "running")
                .values(state="failed")
            )
        raise WorkError(502, str(exc)) from exc
    with engine.begin() as conn:
        lock_account(conn, account)
        latest = read_card(conn, account, module_id)
        state = conn.execute(
            select(jobs.c.state).where(jobs.c.account == account, jobs.c.id == op)
        ).scalar_one_or_none()
        if state != "running":
            raise WorkError(409, "索引任务已失效，迟到结果已丢弃")
        try:
            current_profile = configuration().profile
        except EmbeddingError:
            current_profile = ""
        if (
            not enabled()
            or not latest.usable
            or latest.version != card.version
            or current_profile != config.profile
        ):
            conn.execute(
                update(jobs).where(jobs.c.account == account, jobs.c.id == op).values(state="stale")
            )
            return "stale"
        conn.execute(
            text("DELETE FROM memory_vectors WHERE account=:a AND module_id=:m"),
            {"a": account, "m": module_id},
        )
        value = "CAST(:v AS public.vector)" if conn.dialect.name == "postgresql" else ":v"
        conn.execute(
            text(
                "INSERT INTO memory_vectors (account,module_id,revision,profile,embedding) "
                "VALUES (:a,:m,:r,:p," + value + ")"
            ),
            {
                "a": account,
                "m": module_id,
                "r": card.version,
                "p": config.profile,
                "v": json.dumps(vector),
            },
        )
        conn.execute(
            update(jobs).where(jobs.c.account == account, jobs.c.id == op).values(state="ready")
        )
    with engine.connect() as check:
        return str(
            check.execute(
                select(jobs.c.state).where(jobs.c.account == account, jobs.c.id == op)
            ).scalar_one()
        )
