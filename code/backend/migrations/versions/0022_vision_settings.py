"""Store account-scoped image analysis settings and their write receipts."""

from alembic import op

from todo_backend.modules.images.repository import vision_receipts, vision_settings

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add model configuration tables without rewriting existing rows."""
    vision_settings.create(op.get_bind())
    vision_receipts.create(op.get_bind())


def downgrade() -> None:
    """Require restoring a backup to avoid losing encrypted configuration."""
    raise RuntimeError("请从备份恢复，不能丢弃图片分析模型配置")
