"""Explicit, atomic event-subtree relocation with durable review receipts."""

import hashlib
import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, insert, or_, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.sources.follow import attempts, rules
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.event_repository import branches, links, predecessors, receipts
from todo_backend.modules.work.event_structure import descendants, event, receipt
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.service import WorkError


class MoveInput(BaseModel):
    """User-confirmed destination and impact fingerprint."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    target_id: UUID
    snapshot: str = Field(min_length=64, max_length=64)


def preview(conn: Connection, account: str, event_id: str, target_id: str) -> dict[str, object]:
    """Validate scope and describe everything affected before confirmation."""
    current = event(conn, account, event_id)
    target = read_item(conn, account, target_id)
    if target is None or target.type != "thing":
        raise WorkError(404, "目标事情不存在或不可操作")
    if target_id == current.parent:
        raise WorkError(422, "请选择另一个事情")
    if target.status in ("completed", "cancelled"):
        raise WorkError(409, "目标事情已结束，请先手动重开或选择其他事情")
    module = read_item(conn, account, target.parent or "")
    goal = read_item(conn, account, module.parent or "") if module else None
    if module is None or module.type != "module" or goal is None or goal.type != "goal":
        raise WorkError(404, "目标归属已失效，请刷新后选择")
    moved = {event_id} | descendants(conn, account, event_id)
    rows = list(
        conn.execute(
            select(items).where(
                items.c.account == account, items.c.id.not_in(select(deletions.c.item_id))
            )
        ).mappings()
    )
    if {r["id"] for r in rows if r["id"] in moved and r["parent"] == current.parent} != moved:
        raise WorkError(409, "事件层级异常，请先核对归属")
    tree = list(conn.execute(select(branches).where(branches.c.account == account)).mappings())
    relations = list(conn.execute(select(links).where(links.c.account == account)).mappings())
    if any((r["source"] in moved) != (r["target"] in moved) for r in relations):
        raise WorkError(409, "存在与其他事件的关联，请先在事件详情中移除跨迁移范围的关联")
    visible_ids = {r["id"] for r in rows}
    dependencies = list(
        conn.execute(
            select(predecessors)
            .where(
                predecessors.c.account == account,
                or_(predecessors.c.event_id.in_(moved), predecessors.c.predecessor_id.in_(moved)),
            )
            .order_by(predecessors.c.event_id, predecessors.c.predecessor_id)
        ).mappings()
    )
    if any(
        r["event_id"] in visible_ids
        and r["predecessor_id"] in visible_ids
        and (r["event_id"] in moved) != (r["predecessor_id"] in moved)
        for r in dependencies
    ):
        raise WorkError(409, "迁移会分开前置与后续事件，请先调整跨迁移范围的前置关系")
    documents = list(
        conn.execute(
            select(sources).where(sources.c.account == account, sources.c.context.in_(moved))
        ).mappings()
    )
    proposals = list(
        conn.execute(
            select(suggestions).where(
                suggestions.c.account == account,
                or_(
                    suggestions.c.event_id.in_(moved),
                    suggestions.c.source_id.in_([r["id"] for r in documents]),
                ),
            )
        ).mappings()
    )
    reminders = list(
        conn.execute(
            select(rules).where(rules.c.account == account, rules.c.event_id.in_(moved))
        ).mappings()
    )
    sending = conn.execute(
        select(attempts.c.id).where(
            attempts.c.account == account,
            attempts.c.event_id.in_(moved),
            attempts.c.state == "pending",
        )
    ).first()
    if sending or any(r["state"] == "applying" for r in proposals):
        raise WorkError(409, "有正在处理或结果待核对的操作，请先核对后再迁移")
    groups = (rows, tree, relations, documents, proposals, reminders)
    raw = json.dumps(
        [
            event_id,
            target_id,
            [
                sorted(
                    (dict(r) for r in group),
                    key=lambda r: str(r.get("id", r.get("child_id", r.get("event_id")))),
                )
                for group in groups
            ],
            [dict(r) for r in dependencies],
        ],
        sort_keys=True,
        ensure_ascii=False,
    )
    return {
        "event": current.model_dump(),
        "target": target.model_dump(),
        "target_path": [goal.name, module.name, target.name],
        "snapshot": hashlib.sha256(raw.encode()).hexdigest(),
        "moved_ids": sorted(moved),
        "detached_parent": next((r["parent_id"] for r in tree if r["child_id"] == event_id), None),
        "documents": sum(not r["removed"] for r in documents),
        "discarded_suggestions": sum(r["state"] == "pending" for r in proposals),
        "reminders": len(reminders),
    }


def pause_context(conn: Connection, account: str, moved: set[str], target_id: str) -> None:
    """Invalidate old approvals while retaining provenance and sending history."""
    document_ids = list(
        conn.execute(
            select(sources.c.id).where(sources.c.account == account, sources.c.context.in_(moved))
        ).scalars()
    )
    conn.execute(
        update(sources)
        .where(sources.c.account == account, sources.c.id.in_(document_ids))
        .values(enabled=False, version=sources.c.version + 1, status="事件已迁移，请核对后恢复读取")
    )
    proposals = (
        conn.execute(
            select(suggestions).where(
                suggestions.c.account == account,
                or_(suggestions.c.event_id.in_(moved), suggestions.c.source_id.in_(document_ids)),
            )
        )
        .mappings()
        .all()
    )
    for row in proposals:
        values: dict[str, object] = {}
        if row["state"] == "pending":
            values["state"] = "rejected"
        if row["event_id"] in moved:
            values["thing_id"] = target_id
            if row["state"] == "linked":
                body = json.loads(row["body"])
                body["thing_id"] = target_id
                # Progress evidence follows the event; old placement hints do not.
                target = read_item(conn, account, target_id)
                assert target is not None
                module = read_item(conn, account, target.parent or "")
                assert module is not None
                body.update(module_id=module.id, goal_id=module.parent)
                values["body"] = json.dumps(body, ensure_ascii=False)
        if values:
            conn.execute(update(suggestions).where(suggestions.c.id == row["id"]).values(**values))
    conn.execute(
        update(rules)
        .where(rules.c.account == account, rules.c.event_id.in_(moved))
        .values(enabled=False, version=rules.c.version + 1, status="事件已迁移，请重新核实催办规则")
    )


def move(engine: Engine, account: str, event_id: str, data: MoveInput) -> dict[str, object]:
    """Move a reviewed subtree once and query the committed receipt."""
    op, target_id = str(data.operation_id), str(data.target_id)
    fingerprint = json.dumps(["move", event_id, data.model_dump(mode="json")], sort_keys=True)
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            prior = conn.execute(select(receipts).where(receipts.c.id == op)).mappings().first()
            if prior:
                if prior["account"] != account or prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                impact = preview(conn, account, event_id, target_id)
                if impact["snapshot"] != data.snapshot:
                    raise WorkError(409, "内容已变化，请刷新影响范围后重新确认")
                current = event(conn, account, event_id)
                moved = {event_id} | descendants(conn, account, event_id)
                conn.execute(
                    delete(branches).where(
                        branches.c.account == account, branches.c.child_id == event_id
                    )
                )
                conn.execute(
                    update(items)
                    .where(items.c.account == account, items.c.id.in_(moved))
                    .values(parent=target_id, version=items.c.version + 1)
                )
                pause_context(conn, account, moved, target_id)
                saved = [event(conn, account, key) for key in sorted(moved)]
                if any(row.parent != target_id for row in saved):
                    raise WorkError(409, "迁移结果核对不一致，已回滚")
                conn.execute(
                    insert(receipts).values(
                        id=op,
                        account=account,
                        fingerprint=fingerprint,
                        result=json.dumps(
                            {
                                "action": "move",
                                "event_id": event_id,
                                "target_id": target_id,
                                "source_id": current.parent,
                                "moved_ids": sorted(moved),
                                "operation_id": op,
                            }
                        ),
                    )
                )
        return receipt(engine, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "迁移结果待核对，请查询原操作，不会自动重试") from exc
