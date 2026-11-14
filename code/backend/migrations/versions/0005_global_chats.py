"""Detach legacy chat scope without deleting records or decisions."""

from alembic import op
from sqlalchemy import text

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Pause old chats for explicit reactivation under global account scope."""
    op.get_bind().execute(
        text(
            "UPDATE source_records SET context='', enabled=false, version=version+1, "
            "ai_hash='', status='已解除模块绑定，请核对并恢复；重复群仅启用一条' WHERE kind='chat'"
        )
    )


def downgrade() -> None:
    """Do not invent lost historical scope on rollback."""
    raise RuntimeError("请从备份恢复旧配置")
