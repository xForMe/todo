"""Permanent local message disposal with minimal durable ignore receipts."""

import hashlib
import json

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine

from todo_backend.modules.sources.message_receipts import chat_messages, receipts
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.service import WorkError


def discard_key(mid: str) -> str:
    """Namespace an ignore receipt without storing message text."""
    return "discarded:" + hashlib.sha256(mid.encode()).hexdigest()


def filtered_content(conn: Connection, account: str, address: str, content: str) -> str:
    """Remove explicitly discarded messages before persisting a newly read page."""
    if not content.startswith(("当前页完整\n", "部分结果：仅当前最新一页\n")):
        return content
    ignored = set(
        conn.execute(
            select(receipts.c.message_id).where(
                receipts.c.account == account,
                receipts.c.address == address,
                receipts.c.message_id.like("discarded:%"),
            )
        ).scalars()
    )
    messages = chat_messages(content)
    if not any(discard_key(mid) in ignored for mid in messages):
        return content
    return (
        content.split("\n", 1)[0]
        + "\n"
        + json.dumps(
            [json.loads(raw) for mid, raw in messages.items() if discard_key(mid) not in ignored],
            ensure_ascii=False,
        )
    )


def discard_message(engine: Engine, account: str, sid: str, mid: str, version: int) -> str:
    """Physically remove saved message text and verify durable exclusion in one transaction."""
    with engine.begin() as conn:
        src = (
            conn.execute(
                select(sources).where(
                    sources.c.id == sid,
                    sources.c.account == account,
                    sources.c.kind == "chat",
                    sources.c.removed.is_(False),
                )
            )
            .mappings()
            .first()
        )
        if src is None:
            raise WorkError(404, "来源不存在或不可操作")
        known = set(
            conn.execute(
                select(receipts.c.message_id).where(
                    receipts.c.account == account,
                    receipts.c.address == src["address"],
                )
            ).scalars()
        )
        if discard_key(mid) in known:
            return "已废弃，此消息不会再次识别"
        if src["version"] != version or mid not in chat_messages(src["content"]):
            raise WorkError(409, "来源或消息已变化，请刷新核对")
        raw = chat_messages(src["content"])[mid]
        history = conn.execute(
            select(suggestions.c.body)
            .join(sources, sources.c.id == suggestions.c.source_id)
            .where(
                suggestions.c.account == account,
                sources.c.account == account,
                sources.c.address == src["address"],
            )
        ).scalars()
        if any(json.loads(body)["evidence"] in raw for body in history):
            raise WorkError(409, "该消息已有建议，请刷新后从建议入口核对")
        for key in (mid, discard_key(mid)):
            if key not in known:
                conn.execute(
                    insert(receipts).values(
                        account=account,
                        address=src["address"],
                        message_id=key,
                    )
                )
        snapshots = (
            conn.execute(
                select(sources).where(
                    sources.c.account == account,
                    sources.c.kind == "chat",
                    sources.c.address == src["address"],
                )
            )
            .mappings()
            .all()
        )
        for snapshot in snapshots:
            cleaned = filtered_content(conn, account, str(src["address"]), str(snapshot["content"]))
            changed = conn.execute(
                update(sources)
                .where(
                    sources.c.id == snapshot["id"],
                    sources.c.version == snapshot["version"],
                )
                .values(content=cleaned, version=snapshot["version"] + 1)
            )
            if changed.rowcount != 1:
                raise WorkError(409, "来源正在变化，废弃未保存，请刷新核对")
        saved = conn.execute(select(sources.c.content).where(sources.c.id == sid)).scalar_one()
        if mid in chat_messages(saved):
            raise RuntimeError("废弃结果读回失败")
        from todo_backend.modules.memory.repository import candidates, jobs

        related_sources = select(sources.c.id).where(
            sources.c.account == account, sources.c.address == src["address"]
        )
        affected = (
            conn.execute(
                select(candidates.c.module_id).where(
                    candidates.c.account == account,
                    candidates.c.source_id.in_(related_sources),
                    candidates.c.message_id == mid,
                )
            )
            .scalars()
            .all()
        )
        conn.execute(
            update(candidates)
            .where(
                candidates.c.account == account,
                candidates.c.source_id.in_(related_sources),
                candidates.c.message_id == mid,
            )
            .values(body="", state="invalid")
        )
        # Physical deletion targets only source-derived vectors, never formal business records.
        from sqlalchemy import delete, text

        for module_id in affected:
            conn.execute(
                text("DELETE FROM memory_vectors WHERE account=:a AND module_id=:m"),
                {"a": account, "m": module_id},
            )
            conn.execute(
                delete(jobs).where(jobs.c.account == account, jobs.c.module_id == module_id)
            )
        return "已废弃，本地原文已删除，此消息不会再次识别"
