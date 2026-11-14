"""Create priority records without rewriting existing work."""

from alembic import op

from todo_backend.modules.work.priority_repository import priorities

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add an empty priority table."""
    priorities.create(op.get_bind())


def downgrade() -> None:
    """Protect saved priorities from accidental removal."""
    raise RuntimeError("请从备份恢复，不能丢弃优先级记录")
