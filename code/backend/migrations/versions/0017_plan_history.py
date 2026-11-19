"""Add date history and mark pre-existing plans as historically incomplete."""

from alembic import op
from sqlalchemy import select

from todo_backend.modules.work.plan_history import baselines, changes, initialize
from todo_backend.modules.work.repository import items
from todo_backend.modules.work.schemas import ItemOutput

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Preserve all business records while adding explicit recording baselines."""
    conn = op.get_bind()
    baselines.create(conn)
    changes.create(conn)
    for row in conn.execute(select(items).where(items.c.type.in_(["thing", "event"]))).mappings():
        initialize(
            conn,
            row["account"],
            ItemOutput.model_validate(
                {key: value for key, value in row.items() if key != "account"}
            ),
            True,
        )


def downgrade() -> None:
    """Refuse to discard date history."""
    raise RuntimeError("请从备份恢复，不能丢弃时间变更记录")
