"""Transactional hierarchy, replay and optimistic concurrency rules."""

import json
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from todo_backend.modules.work.repository import items, operations, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput


class WorkError(Exception):
    """Safe business error with an HTTP status."""

    def __init__(self, status: int, message: str) -> None:
        """Record safe status and message."""
        self.status = status
        self.message = message
        super().__init__(message)


def write_item(
    engine: Engine, account: str, data: WriteInput, item_id: str | None = None
) -> ItemOutput:
    """Apply one explicit mutation once, then query its committed result."""
    values = data.model_dump(exclude={"operation_id", "expected_version", "plan_change_reason"})
    fingerprint = json.dumps(
        {"target": item_id, "body": data.model_dump(mode="json")},
        sort_keys=True,
        ensure_ascii=False,
    )
    op = str(data.operation_id)
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            prior = (
                conn.execute(
                    select(operations).where(operations.c.account == account, operations.c.id == op)
                )
                .mappings()
                .first()
            )
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
                result_id = str(prior["item_id"])
            else:
                parent_type = {"module": "goal", "thing": "module", "event": "thing"}
                if data.type == "goal":
                    if data.parent is not None:
                        raise WorkError(422, "目标不能有父项")
                else:
                    parent = read_item(conn, account, data.parent or "")
                    if parent is None or parent.type != parent_type[data.type]:
                        raise WorkError(404, "父项不存在或不可操作")
                result_id = item_id or str(uuid4())
                if item_id:
                    current = read_item(conn, account, item_id)
                    if current is None:
                        raise WorkError(404, "对象不存在或不可操作")
                    if current.type != data.type or current.parent != data.parent:
                        raise WorkError(422, "不能更改归属或类型")
                    if current.version != data.expected_version:
                        raise WorkError(409, "内容已变化，请刷新后编辑")
                    from todo_backend.modules.work.plan_history import record

                    record(conn, account, current, data)
                    if data.type == "event":
                        from todo_backend.modules.work.event_structure import guard_status

                        guard_status(conn, account, item_id, data.status)
                    if (
                        data.type == "thing"
                        and current.status in ("completed", "cancelled")
                        and data.status in ("notStarted", "working")
                    ):
                        from todo_backend.modules.work.priority_repository import priorities

                        conn.execute(
                            update(priorities)
                            .where(priorities.c.item_id == item_id)
                            .values(review_week="")
                        )
                    if current.model_dump(exclude={"id", "version"}) != values:
                        changed = conn.execute(
                            update(items)
                            .where(
                                items.c.id == item_id,
                                items.c.account == account,
                                items.c.version == current.version,
                            )
                            .values(**values, version=current.version + 1)
                        )
                        if changed.rowcount != 1:
                            raise WorkError(409, "内容已变化，请刷新后编辑")
                        if data.type == "event" and any(
                            getattr(current, key) != values[key]
                            for key in ("name", "description", "owner", "status")
                        ):
                            from todo_backend.modules.sources.follow import rules

                            conn.execute(
                                update(rules)
                                .where(rules.c.event_id == item_id, rules.c.account == account)
                                .values(
                                    enabled=False,
                                    status="事件变化，已暂停",
                                    version=rules.c.version + 1,
                                )
                            )
                else:
                    if data.expected_version is not None:
                        raise WorkError(422, "创建时不能指定版本")
                    conn.execute(
                        insert(items).values(id=result_id, account=account, version=1, **values)
                    )
                    if data.type in ("thing", "event"):
                        from todo_backend.modules.work.plan_history import initialize

                        initialize(
                            conn, account, ItemOutput(id=result_id, version=1, **values), False
                        )
                conn.execute(
                    insert(operations).values(
                        account=account, id=op, fingerprint=fingerprint, item_id=result_id
                    )
                )
    except IntegrityError as exc:
        raise WorkError(409, "并发操作冲突，请核对操作结果") from exc
    except SQLAlchemyError as exc:
        raise WorkError(503, "保存失败，请核对操作结果") from exc
    try:
        with engine.connect() as conn:
            result = read_item(conn, account, result_id)
        if result is None:
            raise WorkError(503, "结果待核对，请使用操作标识查询")
        return result
    except SQLAlchemyError as exc:
        raise WorkError(503, "结果待核对，请使用操作标识查询") from exc
