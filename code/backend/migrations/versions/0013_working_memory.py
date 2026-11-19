"""Add one bounded, rebuildable current summary per thing; no event vectors."""

from alembic import op

from todo_backend.modules.memory.repository import working_summaries

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create only the derived working cache; do not read or backfill business data."""
    working_summaries.create(op.get_bind())


def downgrade() -> None:
    """Avoid destructive schema changes during routine feature rollback."""
    raise RuntimeError("关闭记忆功能即可回退；结构降级须另行核对")
