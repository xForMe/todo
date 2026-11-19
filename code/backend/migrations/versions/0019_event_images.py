"""Add private event images and encrypted storage profiles without rewriting business rows."""

from alembic import op

from todo_backend.modules.images.repository import images, profiles, receipts, settings

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the new independent storage tables."""
    for table in (profiles, settings, receipts, images):
        table.create(op.get_bind())


def downgrade() -> None:
    """Keep attachments and encrypted configuration recoverable."""
    raise RuntimeError("请从备份恢复，不能丢弃图片和配置记录")
