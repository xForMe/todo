"""Add independent source storage without changing existing work items."""

from alembic import op
from sqlalchemy import Boolean, Column, Integer, String, Text

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the frozen source storage schema."""
    op.create_table(
        "source_records",
        Column("id", String(36), primary_key=True),
        Column("account", String(120), nullable=False),
        Column("context", String(36), nullable=False),
        Column("kind", String(12), nullable=False),
        Column("address", Text, nullable=False),
        Column("interval", Integer, nullable=False),
        Column("enabled", Boolean, nullable=False),
        Column("removed", Boolean, nullable=False),
        Column("version", Integer, nullable=False),
        Column("next_run", Integer, nullable=False),
        Column("last_run", Integer, nullable=False),
        Column("content", Text, nullable=False),
        Column("status", Text, nullable=False),
    )


def downgrade() -> None:
    """Prevent destructive removal of stored source evidence."""
    raise RuntimeError("请从备份恢复，不支持破坏性降级")
