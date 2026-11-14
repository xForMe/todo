"""Event trees, independent links and durable operation receipts."""

from sqlalchemy import Column, ForeignKey, String, Table, Text, UniqueConstraint

from todo_backend.modules.work.repository import metadata

branches = Table(
    "event_children",
    metadata,
    Column("child_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("parent_id", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("account", String(120), nullable=False),
)
links = Table(
    "event_links",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("source", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("target", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("kind", String(16), nullable=False),
    UniqueConstraint("source", "target"),
)
receipts = Table(
    "event_operations",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("fingerprint", Text, nullable=False),
    Column("result", Text, nullable=False),
)
