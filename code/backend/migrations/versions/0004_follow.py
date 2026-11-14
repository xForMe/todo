"""Persist private reminder rules and at-most-once attempt records."""

from alembic import op
from sqlalchemy import Boolean, Column, Integer, MetaData, String, Table, Text

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None
metadata = MetaData()
rules = Table(
    "follow_rules",
    metadata,
    Column("event_id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("recipient", String(80), nullable=False),
    Column("content", Text, nullable=False),
    Column("at", String(5), nullable=False),
    Column("cap", Integer, nullable=False),
    Column("count", Integer, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("event_version", Integer, nullable=False),
    Column("version", Integer, nullable=False),
    Column("next_run", Integer, nullable=False),
    Column("status", Text, nullable=False),
)
attempts = Table(
    "follow_attempts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("event_id", String(36), nullable=False),
    Column("account", String(120), nullable=False),
    Column("created", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("state", String(16), nullable=False),
    Column("message_id", String(80), nullable=False),
)


def upgrade() -> None:
    """Create reminder storage without altering existing business records."""
    metadata.create_all(op.get_bind())


def downgrade() -> None:
    """Preserve the outbound audit trail."""
    raise RuntimeError("请从备份恢复")
