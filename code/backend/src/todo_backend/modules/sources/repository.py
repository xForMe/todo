"""Persistence and scoped source reads."""

from sqlalchemy import BigInteger, Boolean, Column, Integer, String, Table, Text, select
from sqlalchemy.engine import Connection

from todo_backend.modules.work.repository import metadata

sources = Table(
    "source_records",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("context", String(36), nullable=False),
    Column("kind", String(12), nullable=False),
    Column("address", Text, nullable=False),
    Column("interval", Integer, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("removed", Boolean, nullable=False),
    Column("version", Integer, nullable=False),
    Column("next_run", BigInteger, nullable=False),
    Column("last_run", BigInteger, nullable=False),
    Column("content", Text, nullable=False),
    Column("ai_consent", Boolean, nullable=False, default=False),
    Column("ai_hash", String(64), nullable=False, default=""),
    Column("status", Text, nullable=False),
)


def read_sources(conn: Connection, account: str) -> list[dict[str, object]]:
    """Read only nonremoved sources owned by the caller."""
    rows = conn.execute(
        select(sources).where(sources.c.account == account, sources.c.removed.is_(False))
    ).mappings()
    return [{str(k): v for k, v in row.items() if k != "account"} for row in rows]


suggestions = Table(
    "source_suggestions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("source_id", String(36), nullable=False),
    Column("thing_id", String(36), nullable=False),
    Column("event_id", String(36)),
    Column("event_version", Integer),
    Column("action", String(16), nullable=False),
    Column("body", Text, nullable=False),
    Column("state", String(16), nullable=False),
)
