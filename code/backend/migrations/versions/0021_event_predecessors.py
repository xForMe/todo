"""Add explicit finish-to-start dependencies without converting existing links."""

from alembic import op

from todo_backend.modules.work.event_repository import predecessors

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the new relation table and lookup index."""
    predecessors.create(op.get_bind())


def downgrade() -> None:
    """Require deliberate recovery from the pre-migration backup."""
    raise RuntimeError("请从备份恢复，不能丢弃已保存的事件前置")
