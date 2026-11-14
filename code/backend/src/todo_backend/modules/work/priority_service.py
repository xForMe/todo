"""Explicit priority changes with weekly confirmation and replay protection."""

import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.work.priority_repository import current_week, priorities
from todo_backend.modules.work.repository import items, operations, read_item
from todo_backend.modules.work.schemas import ItemOutput
from todo_backend.modules.work.service import WorkError


class PriorityInput(BaseModel):
    """A reviewed change bound to a work version and calendar week."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_version: int = Field(ge=1)
    week: str
    priority: int = Field(ge=0, le=4)
    review: bool = False


def save_priority(engine: Engine, account: str, item_id: str, data: PriorityInput) -> ItemOutput:
    """Commit once and read back, leaving uncertain responses recoverable."""
    fingerprint = json.dumps(
        {"priority_target": item_id, **data.model_dump(mode="json")}, sort_keys=True
    )
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            prior = (
                conn.execute(
                    select(operations).where(
                        operations.c.account == account, operations.c.id == str(data.operation_id)
                    )
                )
                .mappings()
                .first()
            )
            current = read_item(conn, account, item_id)
            if current is None or current.type != "thing":
                raise WorkError(404, "事情不存在或不可操作")
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                if current.status not in ("notStarted", "working"):
                    raise WorkError(409, "事情已结束，请刷新后核对")
                if data.week != current_week():
                    raise WorkError(409, "评估周期已变化，请刷新后重新核对")
                if current.version != data.expected_version:
                    raise WorkError(409, "事情已变化，请刷新后重新核对")
                if data.review and not data.priority:
                    raise WorkError(422, "请先选择优先级，再确认评估")
                record = (
                    conn.execute(select(priorities).where(priorities.c.item_id == item_id))
                    .mappings()
                    .first()
                )
                values = {
                    "priority": data.priority,
                    "review_week": data.week
                    if data.review
                    else (record["review_week"] if record else ""),
                }
                if record:
                    conn.execute(
                        update(priorities).where(priorities.c.item_id == item_id).values(**values)
                    )
                else:
                    conn.execute(insert(priorities).values(item_id=item_id, **values))
                changed = conn.execute(
                    update(items)
                    .where(
                        items.c.id == item_id,
                        items.c.account == account,
                        items.c.version == data.expected_version,
                    )
                    .values(version=data.expected_version + 1)
                )
                if changed.rowcount != 1:
                    raise WorkError(409, "事情已变化，请刷新后核对")
                conn.execute(
                    insert(operations).values(
                        account=account,
                        id=str(data.operation_id),
                        fingerprint=fingerprint,
                        item_id=item_id,
                    )
                )
        with engine.connect() as conn:
            result = read_item(conn, account, item_id)
        if result is None:
            raise WorkError(503, "结果待核对，请查询操作标识")
        return result
    except SQLAlchemyError as exc:
        raise WorkError(503, "结果待核对，请查询操作标识") from exc
