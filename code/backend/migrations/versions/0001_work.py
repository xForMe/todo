"""Initial work schema snapshot."""

from alembic import op
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, Text

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None
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


def upgrade() -> None:
    """Create the frozen initial schema."""
    metadata.create_all(op.get_bind())


def downgrade() -> None:
    """Protect business data from destructive rollback."""
    raise RuntimeError("请从备份恢复，不支持破坏性降级")
