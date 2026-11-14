"""Versioned attention flags independent of priority and review state."""

import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Boolean, Column, ForeignKey, String, Table, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.work.repository import items, metadata, operations, read_item
from todo_backend.modules.work.schemas import ItemOutput
from todo_backend.modules.work.service import WorkError

attention = Table(
    "thing_attention",
    metadata,
    Column("item_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("enabled", Boolean, nullable=False),
)


class AttentionInput(BaseModel):
    """An explicit desired state tied to the version reviewed by the user."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_version: int = Field(ge=1)
    enabled: bool


def save_attention(engine: Engine, account: str, item_id: str, data: AttentionInput) -> ItemOutput:
    """Save with an atomic receipt, then read the committed work version."""
    fingerprint = json.dumps(
        {"attention_target": item_id, **data.model_dump(mode="json")}, sort_keys=True
    )
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            current = read_item(conn, account, item_id)
            if current is None or current.type != "thing":
                raise WorkError(404, "事情不存在或不可操作")
            prior = conn.execute(
                select(operations.c.fingerprint).where(
                    operations.c.account == account, operations.c.id == str(data.operation_id)
                )
            ).scalar_one_or_none()
            if prior is not None:
                if prior != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                if current.version != data.expected_version:
                    raise WorkError(409, "事情已变化，请刷新后核对")
                if current.status not in ("notStarted", "working", "completed", "cancelled"):
                    raise WorkError(409, "事情状态不可操作")
                exists = conn.execute(
                    select(attention.c.item_id).where(attention.c.item_id == item_id)
                ).scalar_one_or_none()
                if exists:
                    conn.execute(
                        update(attention)
                        .where(attention.c.item_id == item_id)
                        .values(enabled=data.enabled)
                    )
                else:
                    conn.execute(insert(attention).values(item_id=item_id, enabled=data.enabled))
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
