"""Accept a DSH capture only through the authenticated, explicit Web review flow."""

import hashlib
import json
from datetime import date
from typing import Annotated, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)
from sqlalchemy import (
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    String,
    Table,
    Text,
    UniqueConstraint,
    exists,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection, Engine, RowMapping
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.dsh_capture import (
    Candidate,
    Draft,
    draft_view,
    drafts,
    validate_account,
    validate_operation,
)
from todo_backend.modules.sources.placement import create_named, create_work
from todo_backend.modules.work.repository import deletions, items, metadata, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError

confirmations = Table(
    "dsh_capture_confirmations",
    metadata,
    Column("operation_id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("capture_id", String(36), nullable=False),
    Column("fingerprint", String(64), nullable=False),
    Column("event_id", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("result", Text, nullable=False),
    ForeignKeyConstraint(
        ("account", "capture_id"), ("dsh_capture_drafts.account", "dsh_capture_drafts.operation_id")
    ),
    UniqueConstraint("account", "capture_id", name="uq_dsh_capture_confirmation"),
)

_Id = Annotated[str, StringConstraints(max_length=36)]
_PositiveInt = Annotated[int, Field(strict=True, ge=1)]
_UNKNOWN = "保存结果待核对，请只查询原操作，不要重新提交"
_STALE = "所选归属已变化或不可用，请刷新后重新核对"


class Placement(BaseModel):
    """Versions are required for all and only the selected existing path nodes."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    goal_id: str = Field(min_length=1, max_length=36)
    module_id: _Id
    thing_id: _Id
    new_module_name: str = Field(max_length=120)
    new_thing_name: str = Field(max_length=120)
    versions: dict[_Id, _PositiveInt] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def validate_choice(self) -> Self:
        """Require a goal and an explicit existing-or-new choice at each lower level."""
        if self.module_id and self.new_module_name or not (self.module_id or self.new_module_name):
            raise ValueError("请选择已有模块或明确新建模块")
        if self.thing_id and self.new_thing_name or not (self.thing_id or self.new_thing_name):
            raise ValueError("请选择已有事情或明确新建事情")
        if self.new_module_name and not self.new_thing_name:
            raise ValueError("新模块下须明确新建事情")
        selected = [key for key in (self.goal_id, self.module_id, self.thing_id) if key]
        if set(selected) != self.versions.keys() or len(selected) != len(self.versions):
            raise ValueError("归属版本必须与所选已有工作项对应")
        return self


class ConfirmationInput(BaseModel):
    """The reviewed draft revision, approved event fields and selected work snapshot."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    operation_id: UUID
    expected_revision: _PositiveInt
    title: str = Field(min_length=1, max_length=120)
    owner: str = Field(max_length=80)
    planned_date: str = Field(max_length=10)
    placement: Placement

    @model_validator(mode="after")
    def validate_fields(self) -> Self:
        """Reject ambiguous dates and text unsuitable for storage."""
        if self.planned_date:
            try:
                valid_date = date.fromisoformat(self.planned_date).isoformat() == self.planned_date
            except ValueError:
                valid_date = False
            if not valid_date:
                raise ValueError("计划日期须为 YYYY-MM-DD，不包含时分")
        fields = (
            self.title,
            self.owner,
            self.placement.goal_id,
            self.placement.module_id,
            self.placement.thing_id,
            self.placement.new_module_name,
            self.placement.new_thing_name,
        )
        if any("\0" in value for value in fields):
            raise ValueError("内容含有无效字符")
        for value in fields:
            value.encode("utf-8")
        return self


class DraftPage(BaseModel):
    """Pending actionable drafts and the count before page slicing."""

    drafts: list[Draft]
    total: int


class Confirmation(BaseModel):
    """The exact persisted event at acceptance, including its formal ID and fields."""

    model_config = ConfigDict(extra="forbid")
    event: ItemOutput


def list_pending(engine: Engine, account: str, offset: int, limit: int) -> DraftPage:
    """List only committed actionable drafts still awaiting confirmation."""
    validate_account(account)
    pending = drafts.c.account == account, drafts.c.revision > 0, drafts.c.candidate.is_not(None)
    accepted = exists().where(
        confirmations.c.account == drafts.c.account,
        confirmations.c.capture_id == drafts.c.operation_id,
    )
    try:
        with engine.begin() as conn:
            # The count and page must see the same snapshot on both database engines.
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN")
            total = conn.execute(
                select(func.count()).select_from(drafts).where(*pending, ~accepted)
            ).scalar_one()
            rows = conn.execute(
                select(drafts.c.operation_id, drafts.c.revision, drafts.c.candidate)
                .where(*pending, ~accepted)
                .order_by(drafts.c.operation_id)
                .offset(offset)
                .limit(limit)
            ).mappings()
            return DraftPage(
                drafts=[draft_view(row, UUID(row["operation_id"])) for row in rows], total=total
            )
    except (ValueError, SQLAlchemyError) as exc:
        raise WorkError(503, "录入草稿暂时无法读取") from exc


def _receipt_view(row: RowMapping) -> Confirmation:
    try:
        result = Confirmation.model_validate_json(row["result"], strict=True)
    except ValidationError as exc:
        raise WorkError(503, _UNKNOWN) from exc
    if (
        result.event.model_fields_set != set(ItemOutput.model_fields)
        or result.event.id != row["event_id"]
        or result.event.type != "event"
        or not result.event.parent
        or result.event.version != 1
        or result.event.status != "notStarted"
    ):
        raise WorkError(503, _UNKNOWN)
    return result


def _read_receipt(
    conn: Connection, account: str, capture_id: UUID, operation_id: UUID
) -> Confirmation | None:
    row = (
        conn.execute(
            select(confirmations).where(
                confirmations.c.account == account,
                confirmations.c.capture_id == str(capture_id),
                confirmations.c.operation_id == str(operation_id),
            )
        )
        .mappings()
        .one_or_none()
    )
    return _receipt_view(row) if row is not None else None


def receipt(engine: Engine, account: str, capture_id: UUID, operation_id: UUID) -> Confirmation:
    """Recover just this receipt; never create or infer a result by capture ID alone."""
    validate_operation(account, capture_id)
    validate_operation(account, operation_id)
    try:
        with engine.connect() as conn:
            result = _read_receipt(conn, account, capture_id, operation_id)
    except SQLAlchemyError as exc:
        raise WorkError(503, _UNKNOWN) from exc
    if result is None:
        raise WorkError(404, "未找到该录入确认操作的回执")
    return result


def _chosen_parent(conn: Connection, account: str, choice: Placement) -> str:
    chain: list[tuple[str, str, str | None]] = [(choice.goal_id, "goal", None)]
    if choice.module_id:
        chain.append((choice.module_id, "module", choice.goal_id))
    if choice.thing_id:
        chain.append((choice.thing_id, "thing", choice.module_id))
    # Lock the reviewed goal/module/thing, including parents of explicitly new nodes.
    for identifier, kind, parent in chain:
        row = conn.execute(
            select(items.c.type, items.c.parent, items.c.status, items.c.version)
            .where(
                items.c.account == account,
                items.c.id == identifier,
                items.c.id.not_in(select(deletions.c.item_id)),
            )
            .with_for_update()
        ).one_or_none()
        if (
            row is None
            or (row.type, row.parent) != (kind, parent)
            or row.status not in ("notStarted", "working")
            or row.version != choice.versions[identifier]
        ):
            raise WorkError(409, _STALE)
    module = choice.module_id or create_named(
        conn, account, "module", choice.goal_id, choice.new_module_name
    )
    return choice.thing_id or create_named(conn, account, "thing", module, choice.new_thing_name)


def _write_confirmation(
    conn: Connection, account: str, capture_id: UUID, data: ConfirmationInput
) -> bool:
    """Return whether this transaction created a new event (rather than replaying)."""
    capture_key, operation_key = str(capture_id), str(data.operation_id)
    fingerprint = hashlib.sha256(
        json.dumps(data.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()
    draft_row = (
        conn.execute(
            select(drafts)
            .where(drafts.c.account == account, drafts.c.operation_id == capture_key)
            .with_for_update()
        )
        .mappings()
        .one_or_none()
    )
    if draft_row is None or draft_row["revision"] < 1 or not draft_row["candidate"]:
        raise WorkError(404, "未找到可确认的录入草稿")
    prior = conn.execute(
        select(
            confirmations.c.account, confirmations.c.capture_id, confirmations.c.fingerprint
        ).where(confirmations.c.operation_id == operation_key)
    ).one_or_none()
    if prior is not None:
        if tuple(prior) != (account, capture_key, fingerprint):
            raise WorkError(409, "该操作标识已用于其他内容")
        return False
    if (
        conn.scalar(
            select(confirmations.c.operation_id).where(
                confirmations.c.account == account, confirmations.c.capture_id == capture_key
            )
        )
        is not None
    ):
        raise WorkError(409, "该录入草稿已确认，请勿重新提交")
    if draft_row["revision"] != data.expected_revision:
        raise WorkError(409, "录入草稿已变化，请刷新后重新核对")
    candidate: Candidate | None = draft_view(draft_row, capture_id).candidate
    if candidate is None:
        raise WorkError(404, "未找到可确认的录入草稿")
    parent = _chosen_parent(conn, account, data.placement)
    event_id = create_work(
        conn,
        account,
        ItemInput(
            type="event",
            parent=parent,
            name=data.title,
            description=candidate.evidence,
            owner=data.owner,
            planEnd=data.planned_date,
        ),
    )
    event = read_item(conn, account, event_id)
    if event is None:
        raise WorkError(503, _UNKNOWN)
    insert = sqlite_insert if conn.dialect.name == "sqlite" else pg_insert
    saved = conn.execute(
        insert(confirmations)
        .values(
            operation_id=operation_key,
            account=account,
            capture_id=capture_key,
            fingerprint=fingerprint,
            event_id=event_id,
            result=Confirmation(event=event).model_dump_json(),
        )
        .on_conflict_do_nothing()
    )
    if saved.rowcount != 1:
        raise WorkError(409, "录入确认发生冲突，请核对原操作")
    return True


def confirm(
    engine: Engine, account: str, capture_id: UUID, data: ConfirmationInput
) -> Confirmation:
    """Commit the approved hierarchy and receipt together, then verify the actual result."""
    validate_operation(account, capture_id)
    validate_operation(account, data.operation_id)
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            created = _write_confirmation(conn, account, capture_id, data)
        with engine.connect() as conn:
            result = _read_receipt(conn, account, capture_id, data.operation_id)
            if result is None or (
                created and read_item(conn, account, result.event.id) != result.event
            ):
                raise WorkError(503, _UNKNOWN)
            # A replay returns the historical committed response, not a later edit.
            return result
    except (SQLAlchemyError, ValidationError) as exc:
        raise WorkError(503, _UNKNOWN) from exc
