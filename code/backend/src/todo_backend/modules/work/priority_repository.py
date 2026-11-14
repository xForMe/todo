"""Weekly priority persistence and scoped reads."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import Column, ForeignKey, Integer, String, Table, select
from sqlalchemy.engine import Connection

from todo_backend.modules.work.repository import deletions, items, metadata

priorities = Table(
    "thing_priorities",
    metadata,
    Column("item_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("priority", Integer, nullable=False),
    Column("review_week", String(10), nullable=False),
)


def current_week() -> str:
    """Return Monday in the explicit UTC+8 business timezone."""
    today = datetime.now(timezone(timedelta(hours=8))).date()
    return (today - timedelta(days=today.weekday())).isoformat()


def overview(conn: Connection, account: str) -> dict[str, object]:
    """Read priorities only for visible things owned by this account."""
    week = current_week()
    rows = conn.execute(
        select(
            items.c.id,
            items.c.version,
            items.c.status,
            priorities.c.priority,
            priorities.c.review_week,
        )
        .select_from(items.outerjoin(priorities, items.c.id == priorities.c.item_id))
        .where(
            items.c.account == account,
            items.c.type == "thing",
            items.c.id.not_in(select(deletions.c.item_id)),
        )
    ).mappings()
    return {
        "week": week,
        "items": [
            dict(
                row,
                priority=row["priority"] or 0,
                due=row["status"] in ("notStarted", "working") and row["review_week"] != week,
            )
            for row in rows
        ],
    }
