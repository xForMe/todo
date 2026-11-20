"""Append-only follow-ups with scoped model recognition and atomic plan history."""

import json
from datetime import date
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Column, ForeignKey, String, Table, Text, insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.client import AIError
from todo_backend.integrations.ai.follow_up import (
    Decision,
    grounded_completion,
    grounded_date,
    recognize_follow_up,
)
from todo_backend.modules import model_catalog
from todo_backend.modules.images.service import ready_images
from todo_backend.modules.work.daily_review import beijing_now, reviews
from todo_backend.modules.work.event_structure import guard_status
from todo_backend.modules.work.plan_history import record
from todo_backend.modules.work.repository import deletions, items, metadata, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput
from todo_backend.modules.work.service import WorkError, pause_event_reminders

followups = Table(
    "action_followups",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False, index=True),
    Column("day", String(10), nullable=False),
    Column("created_at", String(40), nullable=False),
    Column("content", Text, nullable=False),
    Column("fingerprint", Text, nullable=False),
    Column("result", Text, nullable=False),
)


class FollowInput(BaseModel):
    """Explicit save command based on the displayed event and daily summary."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    operation_id: UUID
    expected_version: int = Field(ge=1)
    expected_revision: int = Field(ge=0)
    day: date
    content: str = Field(min_length=1, max_length=4000)
    skip_ai: bool = False
    image_ids: list[UUID] = Field(default_factory=list, max_length=20)


class FollowOutput(BaseModel):
    """Immutable receipt also used as the stored follow-up record."""

    id: str
    item_id: str
    day: str
    created_at: str
    content: str
    note: str
    old_end: str
    new_end: str
    revision: int
    item_version: int
    completed: bool = False
    image_ids: list[str] = Field(default_factory=list)


def scope(conn: Connection, account: str, item_id: str) -> tuple[ItemOutput, str]:
    """Validate the full visible parent chain and capture model context."""
    current = read_item(conn, account, item_id)
    if current is None or current.type != "event":
        raise WorkError(404, "行动不存在或不可操作")
    chain = [current]
    for kind in ("thing", "module", "goal"):
        parent = read_item(conn, account, chain[-1].parent or "")
        if parent is None or parent.type != kind:
            raise WorkError(404, "行动归属已不可用")
        chain.append(parent)
    # Only the current event can be changed. Names of sibling nodes help avoid misattribution.
    nodes = conn.execute(
        select(items.c.id, items.c.name, items.c.version)
        .where(
            items.c.account == account,
            items.c.parent == current.parent,
            items.c.id.not_in(select(deletions.c.item_id)),
        )
        .order_by(items.c.id)
    ).mappings()
    context = json.dumps(
        {
            "current": {**current.model_dump(), "description": current.description[:2000]},
            "path": [
                x.model_dump(include={"id", "name", "type", "parent", "version"})
                for x in reversed(chain[1:])
            ],
            "nodes": [dict(row) for row in nodes],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return current, context


def revision(conn: Connection, account: str, item_id: str, day: str) -> int:
    """Read the independent daily summary revision."""
    return (
        conn.execute(
            select(reviews.c.revision).where(
                reviews.c.account == account, reviews.c.item_id == item_id, reviews.c.day == day
            )
        ).scalar_one_or_none()
        or 0
    )


def receipt(conn: Connection, account: str, operation_id: str) -> FollowOutput:
    """Read an account-scoped confirmed operation without resubmitting."""
    raw = conn.execute(
        select(followups.c.result).where(
            followups.c.account == account, followups.c.id == operation_id
        )
    ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "尚未查到跟进提交记录")
    result = FollowOutput.model_validate_json(raw)
    scope(conn, account, result.item_id)
    return result


def view(conn: Connection, account: str, item_id: str) -> dict[str, object]:
    """Read today's entries and legacy marker in one transaction."""
    current, _ = scope(conn, account, item_id)
    day = beijing_now().date().isoformat()
    rows = conn.execute(
        select(followups.c.result)
        .where(
            followups.c.account == account, followups.c.item_id == item_id, followups.c.day == day
        )
        .order_by(followups.c.created_at.desc(), followups.c.id.desc())
    ).scalars()
    legacy = conn.execute(
        select(reviews.c.reviewed_at).where(
            reviews.c.account == account, reviews.c.item_id == item_id, reviews.c.day == day
        )
    ).scalar_one_or_none()
    records = [FollowOutput.model_validate_json(raw).model_dump() for raw in rows]
    return {
        "item": current.model_dump(),
        "day": day,
        "records": records,
        "revision": revision(conn, account, item_id, day),
        "legacy_at": legacy if not records else None,
    }


def guard(current: ItemOutput, rev: int, data: FollowInput) -> None:
    """Reject stale, ended or cross-day saves both before and after recognition."""
    if data.day != beijing_now().date():
        raise WorkError(409, "日期已变化，请重新读取后保存；正文已保留")
    if current.status not in ("notStarted", "working"):
        raise WorkError(409, "行动已结束，不能写入跟进")
    if current.version != data.expected_version or rev != data.expected_revision:
        raise WorkError(409, "事项或跟进已变化，请重新读取核对；正文已保留")


def completion(
    conn: Connection, account: str, decision: Decision, data: FollowInput, current: ItemOutput
) -> tuple[bool, str]:
    """Allow only a grounded completion that passes the normal event status guard."""
    if (
        decision.target_id != current.id
        or decision.end
        or decision.date_text
        or decision.reason
        or not grounded_completion(data.content, decision.evidence)
    ):
        return False, "完成依据不足或对象不明确，状态未变更"
    try:
        guard_status(conn, account, current.id, "completed")
    except WorkError as exc:
        if exc.status != 409:
            raise
        return False, "状态未变更；" + exc.message
    return True, "已标记为完成；计划日期未变更"


def plan(decision: Decision, data: FollowInput, current: ItemOutput) -> tuple[str, str]:
    """Independently check source evidence, scope and dates before allowing a mutation."""
    if decision.kind != "delay":
        return "", {
            "none": "",
            "unclear": "延期或完成信息不明确，计划和状态未变更",
            "other": "提到其他节点，请到对应事项跟进；当前计划未变更",
        }[decision.kind]
    if (
        decision.target_id != current.id
        or not decision.evidence
        or decision.evidence not in data.content
        or not decision.reason
        or decision.reason not in data.content
        or not decision.date_text
        or decision.date_text not in decision.evidence
    ):
        return "", "延期依据不足或对象不明确，计划未变更"
    value = grounded_date(decision.date_text, data.day, current.planEnd)
    if (
        not value
        or value != decision.end
        or not current.planEnd
        or value <= current.planEnd
        or (current.planStart and value < current.planStart)
    ):
        return "", "未核实到有效延期日期，计划未变更"
    return value, "已同步计划并加入延期记录；如有催办，请检查并重新保存配置"


def save(engine: Engine, account: str, item_id: str, data: FollowInput) -> FollowOutput:
    """Recognize outside locks, then atomically append follow-up, plan and receipt."""
    values = data.model_dump(mode="json", exclude={"image_ids"} if not data.image_ids else None)
    fingerprint = json.dumps({"item_id": item_id, **values}, sort_keys=True)
    image_ids = [str(value) for value in data.image_ids]
    op = str(data.operation_id)
    try:
        with engine.connect() as conn:
            current, context = scope(conn, account, item_id)
            prior = conn.execute(
                select(followups.c.fingerprint).where(
                    followups.c.account == account, followups.c.id == op
                )
            ).scalar_one_or_none()
            if prior is not None:
                if prior != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
                return receipt(conn, account, op)
            guard(current, revision(conn, account, item_id, data.day.isoformat()), data)
            if image_ids:
                ready_images(conn, account, item_id, image_ids)
            model_override = (
                () if data.skip_ai else model_catalog.override(conn, account, "daily_follow_up")
            )
        try:
            decision = (
                Decision(kind="none")
                if data.skip_ai
                else recognize_follow_up(
                    data.content,
                    json.dumps({"beijing_day": data.day.isoformat(), "work": context}),
                    *model_override,
                )
            )
        except AIError as exc:
            raise WorkError(502, "识别失败，正文尚未保存；可重试识别或明确仅保存跟进") from exc
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            conn.execute(
                select(items.c.id)
                .where(items.c.id == item_id, items.c.account == account)
                .with_for_update()
            )
            current, latest_context = scope(conn, account, item_id)
            prior = conn.execute(
                select(followups.c.fingerprint).where(
                    followups.c.account == account, followups.c.id == op
                )
            ).scalar_one_or_none()
            if prior is not None:
                if prior != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                rev = revision(conn, account, item_id, data.day.isoformat())
                guard(current, rev, data)
                if image_ids:
                    ready_images(conn, account, item_id, image_ids, lock=True)
                if latest_context != context:
                    raise WorkError(409, "识别期间事项归属或内容已变化，请重新核对")
                end, completed = "", False
                if data.skip_ai:
                    note = "仅保存跟进，尚未识别，计划和状态未变更"
                elif decision.kind == "complete":
                    completed, note = completion(conn, account, decision, data, current)
                else:
                    end, note = plan(decision, data, current)
                if end:
                    write = WriteInput.model_validate(
                        {
                            **current.model_dump(exclude={"id", "version"}),
                            "operation_id": data.operation_id,
                            "expected_version": current.version,
                            "planEnd": end,
                            "plan_change_reason": decision.reason,
                        }
                    )
                    record(conn, account, current, write)
                if end or completed:
                    changes = {"status": "completed"} if completed else {"planEnd": end}
                    changed = conn.execute(
                        update(items)
                        .where(
                            items.c.id == item_id,
                            items.c.account == account,
                            items.c.version == current.version,
                        )
                        .values(**changes, version=current.version + 1)
                    )
                    if changed.rowcount != 1:
                        raise WorkError(409, "事项已变化，请重新核对")
                    if completed:
                        pause_event_reminders(conn, account, item_id)
                result = FollowOutput(
                    id=op,
                    item_id=item_id,
                    day=data.day.isoformat(),
                    created_at=beijing_now().isoformat(),
                    content=data.content,
                    image_ids=image_ids,
                    note=note,
                    old_end=current.planEnd,
                    new_end=end or current.planEnd,
                    revision=rev + 1,
                    item_version=current.version + (bool(end) or completed),
                    completed=completed,
                )
                where = (
                    reviews.c.account == account,
                    reviews.c.item_id == item_id,
                    reviews.c.day == result.day,
                )
                if rev:
                    conn.execute(
                        update(reviews)
                        .where(*where)
                        .values(reviewed_at=result.created_at, revision=result.revision)
                    )
                else:
                    conn.execute(
                        insert(reviews).values(
                            account=account,
                            item_id=item_id,
                            day=result.day,
                            reviewed_at=result.created_at,
                            revision=result.revision,
                        )
                    )
                conn.execute(
                    insert(followups).values(
                        account=account,
                        id=op,
                        item_id=item_id,
                        day=result.day,
                        created_at=result.created_at,
                        content=data.content,
                        fingerprint=fingerprint,
                        result=result.model_dump_json(),
                    )
                )
        with engine.connect() as conn:
            return receipt(conn, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "跟进保存结果待核对，请查询原操作标识") from exc
