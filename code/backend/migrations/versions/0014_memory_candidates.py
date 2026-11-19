"""Add source-grounded memory candidates and explicit suggestion citations."""

from alembic import op

from todo_backend.modules.memory.repository import candidates, origins, suggestion_refs

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add bounded derived stores without extracting any historical content."""
    for table in (candidates, origins, suggestion_refs):
        table.create(op.get_bind())


def downgrade() -> None:
    """Do not discard rejection receipts or source dependencies during rollback."""
    raise RuntimeError("关闭记忆功能即可回退；删除候选与来源依赖须另行核对")
