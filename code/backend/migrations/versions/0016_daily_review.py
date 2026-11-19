"""Persist daily reviews without changing existing work records."""

from alembic import op

from todo_backend.modules.work.daily_review import receipts, reviews

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create empty review and receipt tables."""
    reviews.create(op.get_bind())
    receipts.create(op.get_bind())


def downgrade() -> None:
    """Retain history on accidental downgrade."""
    raise RuntimeError("请从备份恢复，不能丢弃每日梳理记录")
