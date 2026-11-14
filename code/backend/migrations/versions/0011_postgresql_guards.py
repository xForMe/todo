"""Preserve deletion and relation write fences on PostgreSQL."""

from alembic import op
from sqlalchemy import BigInteger

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Install equivalent PostgreSQL guards without rewriting business records."""
    if op.get_bind().dialect.name != "postgresql":
        return
    for table, fields in (
        ("source_records", ("next_run", "last_run")),
        ("follow_rules", ("next_run",)),
        ("follow_attempts", ("created",)),
    ):
        for field in fields:
            op.alter_column(table, field, type_=BigInteger())
    conditions = {
        "work_items": "EXISTS (SELECT 1 FROM work_deletions "
        "WHERE item_id=NEW.parent OR item_id=NEW.id)",
        "work_deletions": "EXISTS (SELECT 1 FROM work_items WHERE parent=NEW.item_id "
        "AND id NOT IN (SELECT item_id FROM work_deletions))",
        "source_records": "EXISTS (SELECT 1 FROM work_deletions WHERE item_id=NEW.context)",
        "source_suggestions": "EXISTS (SELECT 1 FROM work_deletions WHERE item_id=NEW.thing_id)",
    }
    for table, source, target in (
        ("event_children", "parent_id", "child_id"),
        ("event_links", "source", "target"),
    ):
        conditions[table] = f"""NEW.{source}=NEW.{target} OR NOT EXISTS (
            SELECT 1 FROM work_items a JOIN work_items b ON a.parent=b.parent
            WHERE a.id=NEW.{source} AND b.id=NEW.{target}
            AND a.type='event' AND b.type='event'
            AND a.account=NEW.account AND b.account=NEW.account
            AND a.id NOT IN (SELECT item_id FROM work_deletions)
            AND b.id NOT IN (SELECT item_id FROM work_deletions))"""
    for table, condition in conditions.items():
        op.execute(f"""
            CREATE FUNCTION guard_{table}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF {condition} THEN
                    RAISE EXCEPTION 'invalid active scope' USING ERRCODE='23514';
                END IF;
                RETURN NEW;
            END $$
        """)
        op.execute(f"""
            CREATE TRIGGER active_scope BEFORE INSERT OR UPDATE ON {table}
            FOR EACH ROW EXECUTE FUNCTION guard_{table}()
        """)


def downgrade() -> None:
    """Require explicit restore rather than silently removing safety fences."""
    raise RuntimeError("请从备份恢复，不能直接移除数据库写入保护")
