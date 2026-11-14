"""Preserve deleted work and prevent references to deleted parents."""

from alembic import op
from sqlalchemy import Column, ForeignKey, String, Text

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add deletion receipts and SQLite write fences without changing records."""
    op.create_table(
        "work_deletions",
        Column("id", String(36), primary_key=True),
        Column("account", String(120), nullable=False),
        Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False, unique=True),
        Column("fingerprint", Text, nullable=False),
        Column("result", Text, nullable=False),
    )
    if op.get_bind().dialect.name == "sqlite":
        for action in ("INSERT", "UPDATE"):
            op.execute(f"""
                CREATE TRIGGER work_active_{action.lower()} BEFORE {action} ON work_items
                WHEN EXISTS (SELECT 1 FROM work_deletions
                    WHERE item_id=NEW.parent OR item_id=NEW.id)
                BEGIN SELECT RAISE(ABORT, 'work item deleted'); END
            """)
        op.execute("""
            CREATE TRIGGER deletion_children BEFORE INSERT ON work_deletions
            WHEN EXISTS (SELECT 1 FROM work_items WHERE parent=NEW.item_id
                AND id NOT IN (SELECT item_id FROM work_deletions))
            BEGIN SELECT RAISE(ABORT, 'active children remain'); END
        """)
        for table, field in (("source_records", "context"), ("source_suggestions", "thing_id")):
            for action in ("INSERT", "UPDATE"):
                op.execute(f"""
                    CREATE TRIGGER {table}_active_{action.lower()} BEFORE {action} ON {table}
                    WHEN EXISTS (SELECT 1 FROM work_deletions WHERE item_id=NEW.{field})
                    BEGIN SELECT RAISE(ABORT, 'source context deleted'); END
                """)


def downgrade() -> None:
    """Require backup restoration rather than resurrecting deleted records."""
    raise RuntimeError("请从备份恢复，不能直接撤销删除记录")
