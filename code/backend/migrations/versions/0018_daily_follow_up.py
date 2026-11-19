"""Add append-only daily follow-ups without changing existing business rows."""

from alembic import op

from todo_backend.modules.work.daily_follow_up import followups

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the follow-up records and immutable operation receipts."""
    followups.create(op.get_bind())


def downgrade() -> None:
    """Never discard follow-up history."""
    raise RuntimeError("请从备份恢复，不能丢弃跟进历史")
