"""Store image analysis batches and confirmed event sources."""

from alembic import op

from todo_backend.modules.images.repository import action_runs, action_sources

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Keep all attachment rows intact and add analysis receipts."""
    action_runs.create(op.get_bind())
    action_sources.create(op.get_bind())


def downgrade() -> None:
    """Preserve the source and confirmation history of generated events."""
    raise RuntimeError("请从备份恢复，不能丢弃图片分析和确认记录")
