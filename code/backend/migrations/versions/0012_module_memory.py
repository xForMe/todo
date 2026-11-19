"""Add selective module memory without embedding existing events."""

from alembic import op

from todo_backend.modules.memory.repository import cards, create_vector_table, jobs, receipts

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create memory stores; PostgreSQL requires an explicitly installed extension."""
    conn = op.get_bind()
    create_vector_table(conn)
    cards.create(conn)
    receipts.create(conn)
    jobs.create(conn)


def downgrade() -> None:
    """Prevent accidental destruction of user-confirmed knowledge."""
    raise RuntimeError("关闭记忆功能即可回退；删除确认记忆须另行备份核对")
