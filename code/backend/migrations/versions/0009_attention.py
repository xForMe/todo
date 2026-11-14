"""Add attention without rewriting existing work."""

from alembic import op

from todo_backend.modules.work.attention import attention

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create an empty attention table."""
    attention.create(op.get_bind())


def downgrade() -> None:
    """Preserve attention history on accidental downgrade."""
    raise RuntimeError("请从备份恢复，不能丢弃关注记录")
