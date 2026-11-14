"""Preserve successful chat snapshots as message processing receipts."""

import hashlib

from alembic import op
from sqlalchemy import insert, select

from todo_backend.modules.sources.message_receipts import chat_messages, receipts
from todo_backend.modules.sources.repository import sources

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Seed only snapshots whose successful recognition hash can be verified."""
    conn = op.get_bind()
    receipts.create(conn)
    seen: set[tuple[str, str, str]] = set()
    for row in conn.execute(select(sources).where(sources.c.kind == "chat")).mappings():
        if (
            not row["content"]
            or hashlib.sha256(row["content"].encode()).hexdigest() != row["ai_hash"]
        ):
            continue
        try:
            messages = chat_messages(row["content"])
        except ValueError:
            continue
        for mid in messages:
            key = (row["account"], row["address"], mid)
            if key not in seen:
                conn.execute(
                    insert(receipts).values(account=key[0], address=key[1], message_id=mid)
                )
                seen.add(key)


def downgrade() -> None:
    """Keep processing history rather than allow accidental replay."""
    raise RuntimeError("请从备份恢复，不能丢弃消息处理回执")
