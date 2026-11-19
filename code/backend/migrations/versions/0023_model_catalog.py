"""Add the model catalog and scenario selections without changing legacy settings."""

from alembic import op

from todo_backend.modules.model_catalog import catalogs, receipts

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the configuration and operations tables."""
    catalogs.create(op.get_bind())
    receipts.create(op.get_bind())


def downgrade() -> None:
    """Preserve saved model profiles, credentials and assignments."""
    raise RuntimeError("请从备份恢复，不能丢弃模型目录及场景配置")
