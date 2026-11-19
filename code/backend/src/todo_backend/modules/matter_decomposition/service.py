"""Planning snapshots, scoped configuration and atomic event confirmation."""

import hashlib
import json
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.matter_decomposition.repository import list_types, runs, types
from todo_backend.modules.matter_decomposition.schemas import ConfirmInput, TypeWrite
from todo_backend.modules.work.event_repository import receipts
from todo_backend.modules.work.event_structure import receipt
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.service import WorkError


def context(conn: Connection, account: str, matter_id: str) -> dict[str, object]:
    """Bind all relevant business and configuration versions to a review snapshot."""
    matter = read_item(conn, account, matter_id)
    if not matter or matter.type != "thing":
        raise WorkError(404, "事情不存在或不可操作")
    if matter.status in ("completed", "cancelled"):
        raise WorkError(409, "请先手动重开事情")
    module = read_item(conn, account, matter.parent or "")
    goal = read_item(conn, account, module.parent or "") if module else None
    if not module or not goal:
        raise WorkError(409, "事情归属已失效")
    events = [
        dict(row)
        for row in conn.execute(
            select(items)
            .where(
                items.c.account == account,
                items.c.parent == matter_id,
                items.c.type == "event",
                items.c.id.not_in(select(deletions.c.item_id)),
            )
            .order_by(items.c.id)
        ).mappings()
    ]
    data: dict[str, object] = {
        "matter": matter.model_dump(),
        "module": module.model_dump(),
        "goal": goal.model_dump(),
        "events": [{k: v for k, v in row.items() if k != "account"} for row in events],
        "types": [t.model_dump() for t in list_types(conn, account)],
    }
    data["snapshot"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    return data


def begin_write(conn: Connection) -> None:
    """Serialize SQLite mutations; PostgreSQL uses configured serializable isolation."""
    if conn.dialect.name == "sqlite":
        conn.exec_driver_sql("BEGIN IMMEDIATE")


def replay(conn: Connection, account: str, operation_id: str, fingerprint: str) -> bool:
    """Reject operation identifier reuse with different contents."""
    prior = (
        conn.execute(
            select(receipts).where(
                receipts.c.id == operation_id,
                receipts.c.account == account,
            )
        )
        .mappings()
        .first()
    )
    if not prior:
        return False
    if prior["fingerprint"] != fingerprint:
        raise WorkError(409, "操作标识已用于其他内容")
    return True


def record(
    conn: Connection, account: str, op: str, fingerprint: str, result: dict[str, object]
) -> None:
    """Persist the same transaction's read-back receipt."""
    conn.execute(
        insert(receipts).values(
            id=op,
            account=account,
            fingerprint=fingerprint,
            result=json.dumps(result),
        )
    )


def save_type(engine: Engine, account: str, type_id: str, data: TypeWrite) -> dict[str, object]:
    """Save an account override with optimistic concurrency and replay protection."""
    if not type_id or len(type_id) > 36:
        raise WorkError(422, "类型标识无效")
    op = str(data.operation_id)
    fingerprint = json.dumps(["type", type_id, data.model_dump(mode="json")], sort_keys=True)
    try:
        with engine.begin() as conn:
            begin_write(conn)
            if not replay(conn, account, op, fingerprint):
                catalog = list_types(conn, account)
                current = next((t for t in catalog if t.id == type_id), None)
                if (current.version if current else 0) != data.expected_version:
                    raise WorkError(409, "类型已变化，请刷新核对")
                if any(
                    t.id != type_id and t.name.casefold() == data.name.casefold() for t in catalog
                ):
                    raise WorkError(409, "已有同名类型")
                if current is None and len(catalog) >= 20:
                    raise WorkError(422, "最多支持20种事情类型")
                values = {
                    "name": data.name,
                    "prompt": data.prompt,
                    "enabled": data.enabled,
                    "version": data.expected_version + 1,
                }
                existing = conn.execute(
                    select(types.c.id).where(
                        types.c.account == account,
                        types.c.id == type_id,
                    )
                ).first()
                if existing:
                    conn.execute(
                        update(types)
                        .where(
                            types.c.account == account,
                            types.c.id == type_id,
                        )
                        .values(**values)
                    )
                else:
                    conn.execute(insert(types).values(account=account, id=type_id, **values))
                saved = next(t for t in list_types(conn, account) if t.id == type_id)
                record(conn, account, op, fingerprint, {"type": saved.model_dump()})
        return receipt(engine, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "保存结果待核对，请查询原操作标识") from exc


def confirm(engine: Engine, account: str, matter_id: str, data: ConfirmInput) -> dict[str, object]:
    """Create selected top-level events and an immutable receipt atomically."""
    op = str(data.operation_id)
    fingerprint = json.dumps(["matter", matter_id, data.model_dump(mode="json")], sort_keys=True)
    try:
        with engine.begin() as conn:
            begin_write(conn)
            if not replay(conn, account, op, fingerprint):
                current = context(conn, account, matter_id)
                if current["snapshot"] != data.snapshot:
                    raise WorkError(409, "事情、事件或类型已变化，请重新核对")
                basis = None
                if data.generation_id:
                    run = (
                        conn.execute(
                            select(runs).where(
                                runs.c.id == str(data.generation_id),
                                runs.c.account == account,
                                runs.c.matter_id == matter_id,
                                runs.c.snapshot == data.snapshot,
                            )
                        )
                        .mappings()
                        .first()
                    )
                    if not run:
                        raise WorkError(409, "生成依据已失效")
                    basis = json.loads(run["basis"])
                existing = set(
                    conn.execute(
                        select(items.c.name).where(
                            items.c.account == account,
                            items.c.parent == matter_id,
                            items.c.id.not_in(select(deletions.c.item_id)),
                        )
                    ).scalars()
                )
                created: list[dict[str, object]] = []
                for child in data.events:
                    if child.type != "event" or child.parent != matter_id:
                        raise WorkError(422, "只能在当前事情创建事件")
                    if child.status != "notStarted" or child.name in existing:
                        raise WorkError(422, "事件须未开始且名称不能重复，请区分新一轮行动")
                    existing.add(child.name)
                    item_id = str(uuid4())
                    conn.execute(
                        insert(items).values(
                            id=item_id,
                            account=account,
                            version=1,
                            **child.model_dump(),
                        )
                    )
                    saved = read_item(conn, account, item_id)
                    if saved is None:
                        raise WorkError(503, "创建结果无法核对")
                    from todo_backend.modules.work.plan_history import initialize

                    initialize(conn, account, saved, False)
                    created.append(saved.model_dump())
                record(conn, account, op, fingerprint, {"created": created, "basis": basis})
        return receipt(engine, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "创建结果待核对，请查询原操作标识") from exc
