"""Transactional plan baselines and immutable date-change records."""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import Boolean, Column, ForeignKey, String, Table, Text, insert, select, update
from sqlalchemy.engine import Connection

from todo_backend.modules.work.repository import metadata, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput

baselines = Table(
    "plan_baselines",
    metadata,
    Column("item_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("start", String(10), nullable=False),
    Column("end", String(10), nullable=False),
    Column("scheduled", Boolean, nullable=False),
    Column("incomplete", Boolean, nullable=False),
)
changes = Table(
    "plan_changes",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False, index=True),
    Column("account", String(120), nullable=False),
    Column("operation_id", String(36), nullable=False, unique=True),
    Column("old_start", String(10), nullable=False),
    Column("old_end", String(10), nullable=False),
    Column("new_start", String(10), nullable=False),
    Column("new_end", String(10), nullable=False),
    Column("reason", Text, nullable=False),
    Column("changed_at", String(40), nullable=False),
)


def initialize(conn: Connection, account: str, item: ItemOutput, incomplete: bool) -> None:
    """Capture a known initial plan without inventing earlier history."""
    conn.execute(
        insert(baselines).values(
            item_id=item.id,
            account=account,
            start=item.planStart,
            end=item.planEnd,
            scheduled=bool(item.planStart or item.planEnd),
            incomplete=incomplete,
        )
    )


def record(conn: Connection, account: str, current: ItemOutput, data: WriteInput) -> None:
    """Validate and append a date mutation inside the object's write transaction."""
    from todo_backend.modules.work.service import WorkError

    if current.type not in ("thing", "event"):
        return
    if (current.planStart, current.planEnd) == (data.planStart, data.planEnd):
        return
    if current.status in ("completed", "cancelled"):
        raise WorkError(409, "已结束，请先保存重开状态，再调整计划日期")
    base = (
        conn.execute(select(baselines).where(baselines.c.item_id == current.id)).mappings().first()
    )
    if base is None:
        initialize(conn, account, current, True)
        base = (
            conn.execute(select(baselines).where(baselines.c.item_id == current.id))
            .mappings()
            .one()
        )
    if base["scheduled"] and not data.plan_change_reason:
        raise WorkError(422, "请填写调整原因")
    if not base["scheduled"]:
        conn.execute(
            update(baselines)
            .where(baselines.c.item_id == current.id)
            .values(
                start=data.planStart,
                end=data.planEnd,
                scheduled=True,
            )
        )
    conn.execute(
        insert(changes).values(
            id=str(uuid4()),
            item_id=current.id,
            account=account,
            operation_id=str(data.operation_id),
            old_start=current.planStart,
            old_end=current.planEnd,
            new_start=data.planStart,
            new_end=data.planEnd,
            reason=data.plan_change_reason,
            changed_at=datetime.now(UTC).isoformat(),
        )
    )


def history(conn: Connection, account: str, item_id: str) -> dict[str, object]:
    """Read a visible object's baseline and immutable history in one transaction."""
    from todo_backend.modules.work.service import WorkError

    item = read_item(conn, account, item_id)
    if item is None or item.type not in ("thing", "event"):
        raise WorkError(404, "对象不存在或不可操作")
    base = (
        conn.execute(
            select(baselines).where(baselines.c.item_id == item_id, baselines.c.account == account)
        )
        .mappings()
        .first()
    )
    rows = conn.execute(
        select(changes)
        .where(changes.c.item_id == item_id, changes.c.account == account)
        .order_by(changes.c.changed_at.desc(), changes.c.id.desc())
    ).mappings()
    return {
        "item": item.model_dump(),
        "baseline": dict(base)
        if base
        else {
            "start": item.planStart,
            "end": item.planEnd,
            "scheduled": bool(item.planStart or item.planEnd),
            "incomplete": True,
        },
        "records": [dict(row) for row in rows],
    }
