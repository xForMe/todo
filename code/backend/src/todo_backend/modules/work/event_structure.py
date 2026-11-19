"""Scoped event decomposition, independent links and state guards."""

import hashlib
import json
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.work import event_dependencies
from todo_backend.modules.work.daily_review import beijing_now
from todo_backend.modules.work.event_repository import branches, links, predecessors, receipts
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError


class EventAction(BaseModel):
    """Explicitly reviewed structure mutation."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    snapshot: str = Field(min_length=64, max_length=64)
    action: Literal["children", "followup", "link", "unlink", "predecessors"]
    children: list[ItemInput] = Field(default_factory=list, max_length=20)
    target: str = ""
    kind: Literal["related", "followup"] = "related"
    predecessor_ids: list[UUID] = Field(default_factory=list, max_length=50)


def event(conn: Connection, account: str, event_id: str) -> ItemOutput:
    """Require an active owned event."""
    value = read_item(conn, account, event_id)
    if value is None or value.type != "event":
        raise WorkError(404, "事件不存在或不可操作")
    return value


def state(conn: Connection, account: str, event_id: str) -> dict[str, object]:
    """Read same-matter structure and a consistent review fingerprint."""
    current = event(conn, account, event_id)
    rows = list(
        conn.execute(
            select(items).where(
                items.c.account == account,
                items.c.parent == current.parent,
                items.c.type == "event",
                items.c.id.not_in(select(deletions.c.item_id)),
            )
        ).mappings()
    )
    ids = [r["id"] for r in rows]
    tree = [
        dict(r)
        for r in conn.execute(
            select(branches).where(branches.c.account == account, branches.c.child_id.in_(ids))
        ).mappings()
    ]
    relations = [
        dict(r)
        for r in conn.execute(
            select(links).where(links.c.account == account, links.c.source.in_(ids))
        ).mappings()
    ]
    dependencies = [
        dict(r)
        for r in conn.execute(
            select(predecessors.c.event_id, predecessors.c.predecessor_id)
            .where(predecessors.c.account == account, predecessors.c.event_id.in_(ids))
            .order_by(predecessors.c.event_id, predecessors.c.predecessor_id)
        ).mappings()
    ]
    raw = json.dumps(
        [
            sorted([dict(r) for r in rows], key=lambda r: r["id"]),
            sorted(tree, key=lambda r: str(r["child_id"])),
            sorted(relations, key=lambda r: str(r["id"])),
            dependencies,
        ],
        sort_keys=True,
    )
    return {
        "events": [
            ItemOutput.model_validate({k: v for k, v in r.items() if k != "account"}).model_dump()
            for r in rows
        ],
        "snapshot": hashlib.sha256(raw.encode()).hexdigest(),
        "branches": tree,
        "links": relations,
        "dependencies": dependencies,
        "today": beijing_now().date().isoformat(),
    }


def descendants(conn: Connection, account: str, event_id: str) -> set[str]:
    """Traverse descendants without recursion depth limits."""
    rows = conn.execute(select(branches).where(branches.c.account == account)).mappings().all()
    found: set[str] = set()
    frontier = {event_id}
    while frontier:
        frontier = {str(r["child_id"]) for r in rows if r["parent_id"] in frontier} - found
        found.update(frontier)
    return found


def require_open(conn: Connection, account: str, event_id: str) -> None:
    """Require every ancestor to be explicitly reopened before new work."""
    visited: set[str] = set()
    while event_id:
        if event_id in visited:
            raise WorkError(409, "事件层级异常")
        visited.add(event_id)
        value = event(conn, account, event_id)
        if value.status in ("completed", "cancelled"):
            raise WorkError(409, "请先手动重开：" + value.name)
        event_id = (
            conn.execute(
                select(branches.c.parent_id).where(
                    branches.c.account == account, branches.c.child_id == event_id
                )
            ).scalar_one_or_none()
            or ""
        )


def guard_status(conn: Connection, account: str, event_id: str, status: str) -> None:
    """Enforce completion rules on every work-item editing path."""
    if status in ("completed", "cancelled"):
        ids = descendants(conn, account, event_id)
        blockers = (
            conn.execute(
                select(items.c.name).where(
                    items.c.account == account,
                    items.c.id.in_(ids),
                    items.c.status.not_in(["completed", "cancelled"]),
                )
            )
            .scalars()
            .all()
        )
        if blockers:
            raise WorkError(409, "请先处理未结束子事件：" + "、".join(blockers[:5]))
    else:
        parent = conn.execute(
            select(branches.c.parent_id).where(
                branches.c.account == account, branches.c.child_id == event_id
            )
        ).scalar_one_or_none()
        if parent:
            require_open(conn, account, parent)


def receipt(engine: Engine, account: str, operation_id: str) -> dict[str, object]:
    """Read a durable result after commit or a lost response."""
    with engine.connect() as conn:
        raw = conn.execute(
            select(receipts.c.result).where(
                receipts.c.account == account, receipts.c.id == operation_id
            )
        ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "尚未找到已提交操作，请核对后手动重试原操作")
    result: dict[str, object] = json.loads(raw)
    return result


def mutate(engine: Engine, account: str, event_id: str, data: EventAction) -> dict[str, object]:
    """Atomically create children or change a relation, then read receipt."""
    payload = data.model_dump(mode="json")
    if data.action != "predecessors":
        if data.predecessor_ids:
            raise WorkError(422, "该操作不能写入前置事件")
        # Previously committed event operations must keep the same fingerprint.
        payload.pop("predecessor_ids")
    fingerprint = json.dumps([event_id, payload], sort_keys=True)
    op = str(data.operation_id)
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            prior = (
                conn.execute(
                    select(receipts).where(receipts.c.id == op, receipts.c.account == account)
                )
                .mappings()
                .first()
            )
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                parent = event(conn, account, event_id)
                if state(conn, account, event_id)["snapshot"] != data.snapshot:
                    raise WorkError(409, "事件或关系已变化，请重新打开核对")
                created: list[str] = []
                if data.action in ("children", "followup"):
                    if data.action == "children":
                        require_open(conn, account, event_id)
                    if not data.children:
                        raise WorkError(422, "至少选择一个子事件")
                    existing = set(
                        conn.execute(
                            select(items.c.name)
                            .join(branches, items.c.id == branches.c.child_id)
                            .where(
                                branches.c.parent_id == event_id,
                                items.c.id.not_in(select(deletions.c.item_id)),
                            )
                        ).scalars()
                    )
                    for child in data.children:
                        if child.type != "event" or child.parent != parent.parent:
                            raise WorkError(422, "子事件必须属于当前事情")
                        if child.status != "notStarted" or child.name in existing:
                            raise WorkError(422, "子事件须未开始且名称不能重复")
                        existing.add(child.name)
                        child_id = str(uuid4())
                        conn.execute(
                            insert(items).values(
                                id=child_id, account=account, version=1, **child.model_dump()
                            )
                        )
                        from todo_backend.modules.work.plan_history import initialize
                        from todo_backend.modules.work.schemas import ItemOutput

                        initialize(
                            conn,
                            account,
                            ItemOutput(id=child_id, version=1, **child.model_dump()),
                            False,
                        )
                        if data.action == "children":
                            conn.execute(
                                insert(branches).values(
                                    child_id=child_id, parent_id=event_id, account=account
                                )
                            )
                        else:
                            conn.execute(
                                insert(links).values(
                                    id=str(uuid4()),
                                    account=account,
                                    source=child_id,
                                    target=event_id,
                                    kind="followup",
                                )
                            )
                        created.append(child_id)
                elif data.action == "link":
                    target = event(conn, account, data.target)
                    if target.id == parent.id or target.parent != parent.parent:
                        raise WorkError(422, "仅允许同事情内不同事件关联")
                    duplicate = conn.execute(
                        select(links.c.id).where(
                            links.c.source.in_([event_id, target.id]),
                            links.c.target.in_([event_id, target.id]),
                        )
                    ).first()
                    if duplicate:
                        raise WorkError(409, "这两个事件已有关联")
                    conn.execute(
                        insert(links).values(
                            id=str(uuid4()),
                            account=account,
                            source=event_id,
                            target=target.id,
                            kind=data.kind,
                        )
                    )
                elif data.action == "predecessors":
                    event_dependencies.replace(
                        conn, account, parent, [str(value) for value in data.predecessor_ids]
                    )
                else:
                    relation = (
                        conn.execute(
                            select(links).where(
                                links.c.id == data.target,
                                links.c.account == account,
                            )
                        )
                        .mappings()
                        .first()
                    )
                    if not relation or event_id not in (relation["source"], relation["target"]):
                        raise WorkError(404, "关联不存在或不可操作")
                    conn.execute(delete(links).where(links.c.id == data.target))
                conn.execute(
                    insert(receipts).values(
                        id=op,
                        account=account,
                        fingerprint=fingerprint,
                        result=json.dumps({"created": created, "action": data.action}),
                    )
                )
        return receipt(engine, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "操作结果待核对，请使用原操作标识查询") from exc
