"""Explicit deletion with atomic child transfer and durable receipts."""

import hashlib
import json
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.sources.follow import attempts, rules
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.service import WorkError


class DeleteInput(BaseModel):
    """Reviewed snapshot, destination and stable replay key."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    snapshot: str = Field(min_length=64, max_length=64)
    target_id: UUID | None = None


def preview(conn: Connection, account: str, item_id: str) -> dict[str, object]:
    """Describe impact and fingerprint account state for explicit confirmation."""
    current = read_item(conn, account, item_id)
    if current is None:
        raise WorkError(404, "对象不存在或已删除")
    if current.type == "event":
        raise WorkError(422, "本功能仅支持目标、模块、事情")
    rows = list(
        conn.execute(
            select(items).where(
                items.c.account == account, items.c.id.not_in(select(deletions.c.item_id))
            )
        ).mappings()
    )
    affected = {item_id}
    for _ in range(3):
        affected.update(r["id"] for r in rows if r["parent"] in affected)
    documents = (
        conn.execute(
            select(sources).where(sources.c.account == account, sources.c.context.in_(affected))
        )
        .mappings()
        .all()
    )
    proposals = (
        conn.execute(
            select(suggestions).where(
                suggestions.c.account == account, suggestions.c.thing_id.in_(affected)
            )
        )
        .mappings()
        .all()
    )
    reminder_rows = (
        conn.execute(
            select(rules).where(rules.c.account == account, rules.c.event_id.in_(affected))
        )
        .mappings()
        .all()
    )
    sending = conn.execute(
        select(attempts.c.id).where(
            attempts.c.account == account,
            attempts.c.event_id.in_(affected),
            attempts.c.state == "pending",
        )
    ).first()
    if sending or any(r["state"] == "applying" for r in proposals):
        raise WorkError(409, "有正在处理或结果待核对的操作，请先核对后再删除")
    payload = [[dict(r) for r in group] for group in (rows, documents, proposals, reminder_rows)]
    # Sorting removes query ordering differences without losing field values.
    snapshot = hashlib.sha256(
        json.dumps(
            [sorted(group, key=lambda r: str(r.get("id", r.get("event_id")))) for group in payload],
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    direct = [r for r in rows if r["parent"] == item_id]
    own_refs = any(r["context"] == item_id for r in documents) or any(
        r["thing_id"] == item_id for r in proposals
    )
    return {
        "item": current.model_dump(),
        "snapshot": snapshot,
        "children": len(direct),
        "descendants": len(affected) - 1,
        "documents": len(documents),
        "suggestions": len(proposals),
        "reminders": len(reminder_rows),
        "requires_target": bool(direct or own_refs),
    }


def receipt(engine: Engine, account: str, operation_id: str) -> dict[str, object]:
    """Read the committed result without replaying the deletion."""
    with engine.connect() as conn:
        raw = conn.execute(
            select(deletions.c.result).where(
                deletions.c.account == account, deletions.c.id == operation_id
            )
        ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "未找到已提交删除，请核对后手动提交原操作")
    result: dict[str, object] = json.loads(raw)
    return result


def remove_item(engine: Engine, account: str, item_id: str, data: DeleteInput) -> dict[str, object]:
    """Transfer all content and hide the source atomically; never cascade delete."""
    fingerprint = json.dumps({"item": item_id, **data.model_dump(mode="json")}, sort_keys=True)
    operation_id = str(data.operation_id)
    target_id = str(data.target_id) if data.target_id else None
    try:
        with engine.connect() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            prior = (
                conn.execute(select(deletions).where(deletions.c.id == operation_id))
                .mappings()
                .first()
            )
            if prior:
                if prior["account"] != account or prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                impact = preview(conn, account, item_id)
                if impact["snapshot"] != data.snapshot:
                    raise WorkError(409, "内容已变化，请刷新影响范围后重新确认")
                current = read_item(conn, account, item_id)
                assert current is not None
                target = read_item(conn, account, target_id) if target_id else None
                if target_id and (
                    target is None or target.type != current.type or target_id == item_id
                ):
                    raise WorkError(422, "接收位置须为另一个可用的同类对象")
                if impact["requires_target"] and target is None:
                    raise WorkError(422, "存在下级或关联内容，请先选择接收位置")
                transfer(conn, account, item_id, target_id)
                result = {
                    "deleted_id": item_id,
                    "target_id": target_id,
                    "operation_id": operation_id,
                    "moved_children": impact["children"],
                }
                conn.execute(
                    insert(deletions).values(
                        id=operation_id,
                        account=account,
                        item_id=item_id,
                        fingerprint=fingerprint,
                        result=json.dumps(result),
                    )
                )
            conn.commit()
        return receipt(engine, account, operation_id)
    except SQLAlchemyError as exc:
        raise WorkError(503, "删除结果待核对，请查询原操作，不会自动重试") from exc


def transfer(conn: Connection, account: str, item_id: str, target_id: str | None) -> None:
    """Preserve descendants and provenance, pausing affected automation."""
    rows = list(
        conn.execute(
            select(items).where(
                items.c.account == account, items.c.id.not_in(select(deletions.c.item_id))
            )
        ).mappings()
    )
    affected = {item_id}
    for _ in range(3):
        affected.update(r["id"] for r in rows if r["parent"] in affected)
    moved = {r["id"]: r["version"] for r in rows if r["parent"] == item_id}
    current = read_item(conn, account, item_id)
    target = read_item(conn, account, target_id) if target_id else None
    if current and target and current.type == "module":
        descriptions = list(
            dict.fromkeys(x for x in (target.description, current.description) if x)
        )
        combined = "\n\n".join(descriptions)
        if len(combined) > 10000:
            raise WorkError(422, "融合后的模块说明超过上限，请先整理说明")
        if combined != target.description:
            conn.execute(
                update(items)
                .where(items.c.id == target_id)
                .values(description=combined, version=items.c.version + 1)
            )
    if moved:
        conn.execute(
            update(items)
            .where(items.c.id.in_(moved), items.c.account == account)
            .values(parent=target_id, version=items.c.version + 1)
        )
    conn.execute(
        update(sources)
        .where(sources.c.account == account, sources.c.context.in_(affected))
        .values(enabled=False, version=sources.c.version + 1, status="归属已变化，请核对后恢复")
    )
    if target_id:
        conn.execute(
            update(sources)
            .where(sources.c.account == account, sources.c.context == item_id)
            .values(context=target_id)
        )
    proposal_rows = (
        conn.execute(
            select(suggestions).where(
                suggestions.c.account == account, suggestions.c.thing_id.in_(affected)
            )
        )
        .mappings()
        .all()
    )
    for row in proposal_rows:
        body = json.loads(row["body"])
        thing_id = target_id if row["thing_id"] == item_id else row["thing_id"]
        version = row["event_version"]
        if row["state"] in {"pending", "linked"}:
            body["thing_id"] = thing_id
            if row["event_id"] in moved and version == moved[row["event_id"]]:
                version += 1
        conn.execute(
            update(suggestions)
            .where(suggestions.c.id == row["id"])
            .values(
                thing_id=thing_id, body=json.dumps(body, ensure_ascii=False), event_version=version
            )
        )
    conn.execute(
        update(rules)
        .where(rules.c.account == account, rules.c.event_id.in_(affected))
        .values(enabled=False, version=rules.c.version + 1, status="归属已变化，请重新核实催办规则")
    )

    if current and current.type == "goal" and target_id:
        merge_modules(conn, account, target_id, set(moved))


def merge_modules(conn: Connection, account: str, target_id: str, incoming: set[str]) -> None:
    """Fold exact-name modules, preferring an existing receiver and preserving every child."""
    modules = list(
        conn.execute(
            select(items).where(
                items.c.account == account,
                items.c.parent == target_id,
                items.c.type == "module",
                items.c.id.not_in(select(deletions.c.item_id)),
            )
        ).mappings()
    )
    names = {r["name"] for r in modules if r["id"] in incoming}
    survivors: dict[str, str] = {}
    for row in sorted(modules, key=lambda r: (r["id"] in incoming, r["id"])):
        name = row["name"]
        if name not in names:
            continue
        if name not in survivors:
            survivors[name] = row["id"]
            continue
        source_id, survivor = row["id"], survivors[name]
        impact = preview(conn, account, source_id)
        transfer(conn, account, source_id, survivor)
        operation_id = str(uuid4())
        result = {
            "deleted_id": source_id,
            "target_id": survivor,
            "operation_id": operation_id,
            "moved_children": impact["children"],
        }
        conn.execute(
            insert(deletions).values(
                id=operation_id,
                account=account,
                item_id=source_id,
                fingerprint=json.dumps({"reason": "same_name_module_merge", "target": survivor}),
                result=json.dumps(result),
            )
        )
