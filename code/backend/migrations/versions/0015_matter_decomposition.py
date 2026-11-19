"""Add matter planning configuration and provenance without changing business rows."""

from alembic import op

from todo_backend.modules.matter_decomposition.repository import runs, types

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create only the new planning tables."""
    for table in (types, runs):
        table.create(op.get_bind())


def downgrade() -> None:
    """Require deliberate preservation of user prompts and generation provenance."""
    raise RuntimeError("回退应用前保留提示词及生成依据，不自动删除数据")
