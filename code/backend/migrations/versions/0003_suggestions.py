"""Add explicit AI consent and independently stored suggestions."""

from alembic import op
from sqlalchemy import Boolean, Column, Integer, String, Text

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add consent default-off and immutable source evidence."""
    op.add_column(
        "source_records", Column("ai_consent", Boolean, nullable=False, server_default="0")
    )
    op.add_column(
        "source_records", Column("ai_hash", String(64), nullable=False, server_default="")
    )
    op.create_table(
        "source_suggestions",
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


def downgrade() -> None:
    """Keep source evidence on rollback."""
    raise RuntimeError("请从备份恢复，不支持破坏性降级")
