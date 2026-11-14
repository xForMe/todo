"""Portable relational tables and scoped reads."""

from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, Text, select
from sqlalchemy.engine import Connection

from todo_backend.modules.work.schemas import ItemOutput

metadata = MetaData()
items = Table(
    "work_items",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("type", String(12), nullable=False),
    Column("parent", String(36), ForeignKey("work_items.id")),
    Column("name", String(120), nullable=False),
    Column("description", Text, nullable=False),
    Column("owner", String(80), nullable=False),
    Column("planStart", String(32), nullable=False),
    Column("planEnd", String(32), nullable=False),
    Column("status", String(16), nullable=False),
    Column("version", Integer, nullable=False),
)
operations = Table(
    "work_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", Text, nullable=False),
    Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False),
)


deletions = Table(
    "work_deletions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False, unique=True),
    Column("fingerprint", Text, nullable=False),
    Column("result", Text, nullable=False),
)


def read_item(conn: Connection, account: str, item_id: str) -> ItemOutput | None:
    """Read a single object within the authenticated account."""
    row = (
        conn.execute(
            select(items).where(
                items.c.account == account,
                items.c.id == item_id,
                items.c.id.not_in(select(deletions.c.item_id)),
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return ItemOutput.model_validate({k: v for k, v in row.items() if k != "account"})
