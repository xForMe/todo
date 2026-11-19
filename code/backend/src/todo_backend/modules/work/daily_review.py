"""Explicit daily review records, independent of work completion and priority."""

import json
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Column, ForeignKey, Integer, String, Table, Text, insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.work.repository import items, metadata, read_item
from todo_backend.modules.work.service import WorkError

reviews = Table(
    "action_reviews",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("item_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("day", String(10), primary_key=True),
    Column("reviewed_at", String(40), nullable=False),
    Column("revision", Integer, nullable=False),
)
receipts = Table(
    "action_review_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", Text, nullable=False),
    Column("result", Text, nullable=False),
)


def beijing_now() -> datetime:
    """Use an explicit business timezone independent of the host."""
    return datetime.now(timezone(timedelta(hours=8)))


class ReviewInput(BaseModel):
    """Reviewed event and review versions supplied by the displayed snapshot."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_version: int = Field(ge=1)
    expected_revision: int = Field(ge=0)
    day: date
    reviewed: bool


class ReviewOutput(BaseModel):
    """Immutable mutation receipt including its server-confirmed business day."""

    item_id: str
    day: str
    reviewed_at: str
    revision: int


def receipt(conn: Connection, account: str, operation_id: str) -> ReviewOutput:
    """Resolve an uncertain write without resubmitting it."""
    raw = conn.execute(
        select(receipts.c.result).where(
            receipts.c.account == account, receipts.c.id == operation_id
        )
    ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "尚未查到梳理提交记录")
    return ReviewOutput.model_validate_json(raw)


def save_review(engine: Engine, account: str, item_id: str, data: ReviewInput) -> ReviewOutput:
    """Check scope and versions, commit a daily record and receipt, then read back."""
    fingerprint = json.dumps(
        {"daily_review_target": item_id, **data.model_dump(mode="json")}, sort_keys=True
    )
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            conn.execute(
                select(items.c.id)
                .where(items.c.id == item_id, items.c.account == account)
                .with_for_update()
            )
            current = read_item(conn, account, item_id)
            if current is None or current.type != "event":
                raise WorkError(404, "事件不存在或不可操作")
            parent = current
            for kind in ("thing", "module", "goal"):
                ancestor = read_item(conn, account, parent.parent or "")
                if ancestor is None or ancestor.type != kind:
                    raise WorkError(404, "事件归属已不可用")
                parent = ancestor
            prior = conn.execute(
                select(receipts.c.fingerprint).where(
                    receipts.c.account == account, receipts.c.id == str(data.operation_id)
                )
            ).scalar_one_or_none()
            if prior is not None:
                if prior != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                now = beijing_now()
                if data.day != now.date():
                    raise WorkError(409, "日期已变化，请刷新后重新梳理")
                if current.status not in ("notStarted", "working"):
                    raise WorkError(409, "事件已结束，请刷新")
                if current.version != data.expected_version:
                    raise WorkError(409, "事件已变化，请刷新后核对")
                if not data.reviewed:
                    from todo_backend.modules.work.daily_follow_up import followups

                    if conn.execute(
                        select(followups.c.id).where(
                            followups.c.account == account,
                            followups.c.item_id == item_id,
                            followups.c.day == data.day.isoformat(),
                        )
                    ).first():
                        raise WorkError(409, "已有当日跟进记录，不能通过旧标记撤销")
                where = (
                    reviews.c.account == account,
                    reviews.c.item_id == item_id,
                    reviews.c.day == data.day.isoformat(),
                )
                existing = conn.execute(select(reviews).where(*where)).mappings().first()
                revision = existing["revision"] if existing else 0
                if revision != data.expected_revision:
                    raise WorkError(409, "梳理标记已变化，请刷新后核对")
                timestamp = (
                    (existing["reviewed_at"] if existing else "") or now.isoformat()
                    if data.reviewed
                    else ""
                )
                result = ReviewOutput(
                    item_id=item_id,
                    day=data.day.isoformat(),
                    reviewed_at=timestamp,
                    revision=revision + 1,
                )
                if existing:
                    conn.execute(
                        update(reviews)
                        .where(*where)
                        .values(reviewed_at=timestamp, revision=result.revision)
                    )
                else:
                    conn.execute(insert(reviews).values(account=account, **result.model_dump()))
                conn.execute(
                    insert(receipts).values(
                        account=account,
                        id=str(data.operation_id),
                        fingerprint=fingerprint,
                        result=result.model_dump_json(),
                    )
                )
        with engine.connect() as conn:
            return receipt(conn, account, str(data.operation_id))
    except SQLAlchemyError as exc:
        raise WorkError(503, "梳理保存结果待核对，请查询操作标识") from exc
