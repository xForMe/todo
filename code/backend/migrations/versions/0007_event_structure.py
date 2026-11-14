"""Add independent event structure without rewriting work records."""

from alembic import op

from todo_backend.modules.work.event_repository import branches, links, receipts

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create structure and receipt tables."""
    for table in (branches, links, receipts):
        table.create(op.get_bind())
    if op.get_bind().dialect.name == "sqlite":
        for table, source, target in (
            ("event_children", "parent_id", "child_id"),
            ("event_links", "source", "target"),
        ):
            op.execute(f"""
                CREATE TRIGGER {table}_scope BEFORE INSERT ON {table}
                WHEN NEW.{source}=NEW.{target} OR NOT EXISTS (
                    SELECT 1 FROM work_items a JOIN work_items b ON a.parent=b.parent
                    WHERE a.id=NEW.{source} AND b.id=NEW.{target}
                    AND a.type='event' AND b.type='event'
                    AND a.account=NEW.account AND b.account=NEW.account
                    AND a.id NOT IN (SELECT item_id FROM work_deletions)
                    AND b.id NOT IN (SELECT item_id FROM work_deletions))
                BEGIN SELECT RAISE(ABORT, 'invalid event scope'); END
            """)


def downgrade() -> None:
    """Require restoring a backup rather than dropping event history."""
    raise RuntimeError("请从备份恢复，不能丢弃事件关系")
