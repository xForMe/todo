"""Scope-checked recognition and user-confirmed proposal application."""

import hashlib
import json
from uuid import UUID, uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine, RowMapping
from sqlalchemy.exc import IntegrityError

from todo_backend.integrations.ai.client import AIError, Proposal, Proposals, recognize
from todo_backend.modules.sources.message_receipts import chat_messages, receipts
from todo_backend.modules.sources.placement import Placement, accept_new
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput
from todo_backend.modules.work.service import WorkError, write_item


def analyze_source(engine: Engine, source_id: str) -> None:
    """Recognize a changed snapshot within the stored authorization scope."""
    with engine.connect() as conn:
        source = conn.execute(select(sources).where(sources.c.id == source_id)).mappings().one()
        if (
            source["removed"]
            or not source["enabled"]
            or not source["ai_consent"]
            or not source["content"]
        ):
            return
        digest = hashlib.sha256(source["content"].encode()).hexdigest()
        if source["kind"] != "chat" and digest == source["ai_hash"]:
            return
        content = source["content"]
        pending: dict[str, str] = {}
        if source["kind"] == "chat":
            try:
                messages = chat_messages(content)
            except ValueError:
                with engine.begin() as failure:
                    failure.execute(
                        update(sources)
                        .where(
                            sources.c.id == source_id,
                            sources.c.version == source["version"],
                            sources.c.content == content,
                        )
                        .values(
                            enabled=False,
                            status="聊天消息标识无法核对，已暂停",
                            version=source["version"] + 1,
                        )
                    )
                return
            known = set(
                conn.execute(
                    select(receipts.c.message_id).where(
                        receipts.c.account == source["account"],
                        receipts.c.address == source["address"],
                        receipts.c.message_id.in_(messages),
                    )
                ).scalars()
            )
            pending = {key: value for key, value in messages.items() if key not in known}
            content = "\n".join(pending.values())
        parent = read_item(conn, source["account"], source["context"])
        if parent is None and source["kind"] != "chat":
            return
        all_items = list(
            conn.execute(
                select(items)
                .where(
                    items.c.account == source["account"],
                    items.c.id.not_in(select(deletions.c.item_id)),
                )
                .order_by(items.c.id)
            ).mappings()
        )
        if source["kind"] == "chat":
            thing_ids = {r["id"] for r in all_items if r["type"] == "thing"}
            scoped = all_items
        else:
            assert parent is not None
            thing_ids = {parent.parent} if parent.type == "event" else {parent.id}
            scoped = [r for r in all_items if r["id"] in thing_ids or r["parent"] in thing_ids]
        context = json.dumps(
            work_context(scoped),
            ensure_ascii=False,
        )
    try:
        proposals = recognize(content, context) if content else Proposals(suggestions=[])
        for proposal in proposals.suggestions:
            if source["kind"] == "chat":
                validate_recommendation(proposal, scoped)
            elif proposal.new_module_name or proposal.new_thing_name:
                raise AIError("文档建议不能新建模块或事情")
            if proposal.action == "new" and proposal.event_id is not None:
                raise AIError("新事件不能引用既有事件标识")
            if (
                proposal.thing_id not in thing_ids
                and not (
                    source["kind"] == "chat"
                    and proposal.action == "new"
                    and proposal.thing_id == ""
                )
            ) or proposal.evidence not in content:
                raise AIError("模型归属或原文依据无法核对，未写入建议")
            if proposal.action != "new" and not any(
                r["id"] == proposal.event_id
                and r["parent"] == proposal.thing_id
                and r["type"] == "event"
                for r in scoped
            ):
                raise AIError("模型引用的事件不在授权范围")
        with engine.begin() as conn:
            latest = list(
                conn.execute(
                    select(items)
                    .where(
                        items.c.account == source["account"],
                        items.c.id.not_in(select(deletions.c.item_id)),
                    )
                    .order_by(items.c.id)
                ).mappings()
            )
            if latest != all_items:
                return  # Work changed during model call: discard stale classification.
            claimed = conn.execute(
                update(sources)
                .where(
                    sources.c.id == source_id,
                    sources.c.version == source["version"],
                    sources.c.enabled.is_(True),
                    sources.c.ai_consent.is_(True),
                    sources.c.removed.is_(False),
                    sources.c.content == source["content"],
                    sources.c.ai_hash == source["ai_hash"],
                )
                .values(ai_hash=digest, status="读取及 AI 识别完成")
            )
            if claimed.rowcount != 1:
                return
            for message_id in pending:
                conn.execute(
                    insert(receipts).values(
                        account=source["account"], address=source["address"], message_id=message_id
                    )
                )
            for proposal in proposals.suggestions:
                event = next((r for r in scoped if r["id"] == proposal.event_id), None)
                conn.execute(
                    insert(suggestions).values(
                        id=str(uuid4()),
                        account=source["account"],
                        source_id=source_id,
                        thing_id=proposal.thing_id,
                        event_id=proposal.event_id,
                        event_version=event["version"] if event else None,
                        action=proposal.action,
                        body=proposal.model_dump_json(),
                        state="linked" if proposal.action == "progress" else "pending",
                    )
                )
            stored_hash = conn.execute(
                select(sources.c.ai_hash).where(sources.c.id == source_id)
            ).scalar_one()
            if stored_hash != digest:
                raise RuntimeError("识别结果读回不一致")
    except IntegrityError:
        # Only a proven receipt race is benign; unrelated constraint failures must surface.
        with engine.connect() as check:
            committed = set(
                check.execute(
                    select(receipts.c.message_id).where(
                        receipts.c.account == source["account"],
                        receipts.c.address == source["address"],
                        receipts.c.message_id.in_(pending),
                    )
                ).scalars()
            )
        if pending and committed:
            return
        raise
    except AIError as exc:
        with engine.begin() as conn:
            conn.execute(
                update(sources)
                .where(
                    sources.c.id == source_id,
                    sources.c.version == source["version"],
                    sources.c.enabled.is_(True),
                    sources.c.content == source["content"],
                    sources.c.ai_hash == source["ai_hash"],
                )
                .values(status=str(exc), enabled=False, version=source["version"] + 1)
            )


def resolve_proposal(
    engine: Engine,
    account: str,
    suggestion_id: str,
    accept: bool,
    edited: Proposal | None = None,
    placement: Placement | None = None,
) -> ItemOutput | None:
    """Apply a reviewed proposal once via existing work-operation idempotency."""
    if accept:
        with engine.connect() as check:
            candidate = (
                check.execute(
                    select(suggestions).where(
                        suggestions.c.id == suggestion_id, suggestions.c.account == account
                    )
                )
                .mappings()
                .first()
            )
        if (
            candidate
            and candidate["action"] == "new"
            and (
                candidate["state"] == "pending"
                or (candidate["state"] == "accepted" and candidate["event_id"])
            )
        ):
            return accept_new(engine, account, suggestion_id, edited, placement)
        if placement is not None:
            raise WorkError(422, "只有聊天新事件可新建或修改层级归属")
    with engine.begin() as conn:
        row = (
            conn.execute(
                select(suggestions).where(
                    suggestions.c.id == suggestion_id, suggestions.c.account == account
                )
            )
            .mappings()
            .first()
        )
        if row is None:
            raise WorkError(404, "建议不存在或不可操作")
        if not accept:
            if row["state"] in {"accepted", "applying"}:
                raise WorkError(409, "建议已确认，不能忽略")
            conn.execute(
                update(suggestions)
                .where(suggestions.c.id == suggestion_id)
                .values(state="rejected")
            )
            return None
        if row["state"] not in {"pending", "accepted", "applying"} or row["action"] == "progress":
            raise WorkError(409, "建议不可应用")
        proposal = Proposal.model_validate_json(row["body"])
        if edited is not None and row["state"] == "pending":
            if (
                edited.action != proposal.action
                or edited.event_id != proposal.event_id
                or edited.evidence != proposal.evidence
            ):
                raise WorkError(422, "不能修改来源依据或操作类型")
            if edited.thing_id != proposal.thing_id:
                source = (
                    conn.execute(
                        select(sources).where(
                            sources.c.id == row["source_id"], sources.c.account == account
                        )
                    )
                    .mappings()
                    .one()
                )
                target = read_item(conn, account, edited.thing_id)
                if (
                    source["kind"] != "chat"
                    or proposal.action != "new"
                    or target is None
                    or target.type != "thing"
                ):
                    raise WorkError(422, "归属超出来源授权范围")
            proposal = edited
        if not proposal.thing_id:
            raise WorkError(422, "请先确认所属事情")
        if row["state"] == "pending":
            claimed = conn.execute(
                update(suggestions)
                .where(suggestions.c.id == suggestion_id, suggestions.c.state == "pending")
                .values(body=proposal.model_dump_json(), state="applying")
            )
            if claimed.rowcount != 1:
                raise WorkError(409, "建议正在处理，请核对结果")
        current = read_item(conn, account, row["event_id"]) if row["event_id"] else None
        if row["action"] == "update" and current is None:
            raise WorkError(404, "事件不可访问")
        values = (
            current.model_dump(exclude={"id", "version"})
            if current
            else {"type": "event", "parent": proposal.thing_id}
        )
        values.update(
            name=proposal.name,
            owner=proposal.owner or (current.owner if current else ""),
            planEnd=proposal.plan_end or (current.planEnd if current else ""),
            status=proposal.status,
            description=current.description if current else proposal.evidence,
        )
        data = WriteInput.model_validate(
            {
                **values,
                "operation_id": UUID(suggestion_id),
                "expected_version": row["event_version"] if current else None,
            }
        )
    result = write_item(engine, account, data, row["event_id"])
    with engine.begin() as conn:
        conn.execute(
            update(suggestions).where(suggestions.c.id == suggestion_id).values(state="accepted")
        )
    return result


def validate_recommendation(proposal: Proposal, scope: list[RowMapping]) -> None:
    """Validate optional model hierarchy hints against the authenticated work tree."""
    records = {r["id"]: r for r in scope}
    if proposal.thing_id:
        thing = records.get(proposal.thing_id)
        if thing is None or thing["type"] != "thing":
            raise AIError("推荐事情不可核对")
        if proposal.new_module_name or proposal.new_thing_name:
            raise AIError("已有事情与新建建议冲突")
        if proposal.module_id and proposal.module_id != thing["parent"]:
            raise AIError("推荐模块与事情不一致")
        proposal.module_id = thing["parent"]
    if proposal.module_id:
        module = records.get(proposal.module_id)
        if module is None or module["type"] != "module" or proposal.new_module_name:
            raise AIError("推荐模块不可核对")
        if proposal.goal_id and proposal.goal_id != module["parent"]:
            raise AIError("推荐目标与模块不一致")
        proposal.goal_id = module["parent"]
    if proposal.goal_id:
        goal = records.get(proposal.goal_id)
        if goal is None or goal["type"] != "goal":
            raise AIError("推荐目标不可核对")
    if proposal.action != "new" and (proposal.new_module_name or proposal.new_thing_name):
        raise AIError("已有事件不能建议新层级")


def work_context(scope: list[RowMapping]) -> list[dict[str, object]]:
    """Expose explicit title paths so models need not reconstruct UUID joins."""
    records = {r["id"]: r for r in scope}
    result: list[dict[str, object]] = []
    for row in scope:
        path = [row["name"]]
        parent = row["parent"]
        for _ in range(3):
            if parent not in records:
                break
            ancestor = records[parent]
            path.insert(0, ancestor["name"])
            parent = ancestor["parent"]
        result.append(
            {
                **{k: row[k] for k in ("id", "name", "type", "parent", "status")},
                "path": " / ".join(path),
            }
        )
    return result
