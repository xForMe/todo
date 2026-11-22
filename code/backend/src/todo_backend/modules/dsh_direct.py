"""Create or complete one explicitly approved event and retain its receipt."""

import hashlib
from datetime import date
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Select, insert, select, update
from sqlalchemy.engine import Connection, Engine, RowMapping
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from todo_backend.modules.dsh_capture import validate_account, validate_operation
from todo_backend.modules.sources.placement import create_work
from todo_backend.modules.work.event_structure import guard_status
from todo_backend.modules.work.repository import deletions, items, operations, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError, pause_event_reminders

RECEIPT_PREFIX = "dsh-direct-v1:"
_COMPLETE_PREFIX = RECEIPT_PREFIX + "complete:"
OpenStatus = Literal["notStarted", "working"]
_ACTIVE = ("notStarted", "working")
_LIMIT = 10
_UNKNOWN = "保存结果待核对，请只查询原操作，不要重新提交"
_NOT_FOUND = "未找到该会话操作的回执"
_STALE = "所选事情已变化或不可用，请刷新后重新核对"
_PathName = Annotated[str, Field(min_length=1, max_length=120)]


class DirectInput(BaseModel):
    """Fields approved by the user and the exact parent version they selected."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    thing_id: str = Field(min_length=1, max_length=36)
    expected_version: int = Field(strict=True, ge=1, le=2_147_483_647)
    expected_path: tuple[_PathName, _PathName, _PathName]
    title: str = Field(min_length=1, max_length=120)
    owner: str = Field(default="", max_length=80)
    planned_date: str = Field(default="", max_length=10)
    description: str = Field(default="", max_length=10_000)

    @model_validator(mode="after")
    def validate_fields(self) -> Self:
        """Keep dates unambiguous and reject invalid storage characters."""
        if (
            self.planned_date
            and date.fromisoformat(self.planned_date).isoformat() != self.planned_date
        ):
            raise ValueError("计划日期须为 YYYY-MM-DD，不包含时分")
        fields = (self.thing_id, self.title, self.owner, self.description)
        if any(value != value.strip() for value in fields):
            raise ValueError("内容首尾不能包含空白字符")
        for value in (*fields, *self.expected_path):
            if "\0" in value:
                raise ValueError("内容含有无效字符")
            value.encode("utf-8")
        return self


class CompletionInput(BaseModel):
    """The exact open event shown to the user before approval."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    event_id: UUID
    expected_version: int = Field(strict=True, ge=1, lt=2_147_483_647)
    expected_path: tuple[_PathName, _PathName, _PathName]
    expected_title: _PathName
    expected_status: OpenStatus


class CompletionPreview(BaseModel):
    """A bounded live event summary for the Host approval prompt."""

    event_id: str
    version: int
    title: str
    path: tuple[str, str, str]
    status: OpenStatus


class CompletedEvent(BaseModel):
    """Only the fields needed to verify an approved completion."""

    model_config = ConfigDict(extra="forbid")
    id: str
    type: Literal["event"] = "event"
    status: Literal["completed"] = "completed"
    version: int
    name: str


class CompletionReceipt(BaseModel):
    """Exact post-commit snapshot of an approved completion."""

    model_config = ConfigDict(extra="forbid")
    event: CompletedEvent


class _CompletionLedger(CompletionReceipt):
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class DirectReceipt(BaseModel):
    """Exact snapshot of one event accepted by the direct recording source."""

    model_config = ConfigDict(extra="forbid")
    event: ItemOutput


class _LedgerPayload(DirectReceipt):
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class MatterMatch(BaseModel):
    """A selectable active matter with its complete display path."""

    thing_id: str
    version: int
    path: tuple[str, str, str]


class MatterMatches(BaseModel):
    """Never hide that a query matched more matters than were returned."""

    matters: list[MatterMatch]
    truncated: bool


_thing = items.alias("direct_thing")
_module = items.alias("direct_module")
_goal = items.alias("direct_goal")


def _active_chain(account: str) -> Select[tuple[str, int, str, str, str]]:
    deleted = select(deletions.c.item_id)
    return (
        select(_thing.c.id, _thing.c.version, _goal.c.name, _module.c.name, _thing.c.name)
        .select_from(
            _thing.join(_module, _thing.c.parent == _module.c.id).join(
                _goal, _module.c.parent == _goal.c.id
            )
        )
        .where(
            _goal.c.parent.is_(None),
            *(
                condition
                for node, kind in ((_thing, "thing"), (_module, "module"), (_goal, "goal"))
                for condition in (
                    node.c.account == account,
                    node.c.type == kind,
                    node.c.status.in_(_ACTIVE),
                    node.c.id.not_in(deleted),
                )
            ),
        )
    )


def find_matters(engine: Engine, account: str, query: str) -> MatterMatches:
    """Search literal substrings by matter ID or the full active hierarchy path."""
    validate_account(account)
    query = query.strip()
    try:
        query.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise WorkError(422, "查询格式无效") from exc
    if not query or len(query) > 120 or "\0" in query:
        raise WorkError(422, "查询须为 1–120 个字符")
    path = _goal.c.name + " / " + _module.c.name + " / " + _thing.c.name
    try:
        identifier = str(UUID(query))
    except ValueError:
        match = path.icontains(query, autoescape=True)
    else:
        match = _thing.c.id == identifier
    statement = (
        _active_chain(account)
        .where(match)
        .order_by(_goal.c.name, _module.c.name, _thing.c.name, _thing.c.id)
        .limit(_LIMIT + 1)
    )
    try:
        with engine.connect() as conn:
            matches = conn.execute(statement).all()
    except SQLAlchemyError as exc:
        raise WorkError(503, "暂时无法查询事情") from exc
    return MatterMatches(
        matters=[
            MatterMatch(thing_id=row[0], version=row[1], path=(row[2], row[3], row[4]))
            for row in matches[:_LIMIT]
        ],
        truncated=len(matches) > _LIMIT,
    )


def _completion_preview(
    conn: Connection, account: str, event_id: UUID, *, lock: bool = False
) -> CompletionPreview:
    current = read_item(conn, account, str(event_id))
    if current is None or current.type != "event" or not current.parent:
        raise WorkError(404, "事件不存在或不可操作")
    if current.status not in ("notStarted", "working"):
        raise WorkError(409, "该事件已结束，未更新")
    statement = _active_chain(account).where(_thing.c.id == current.parent)
    row = conn.execute(statement.with_for_update() if lock else statement).one_or_none()
    if row is None:
        raise WorkError(409, "事件或归属已变化，请重新核对")
    return CompletionPreview(
        event_id=current.id,
        version=current.version,
        title=current.name,
        path=(row[2], row[3], row[4]),
        status=current.status,
    )


def preview_completion(engine: Engine, account: str, event_id: UUID) -> CompletionPreview:
    """Read one open event and its live path without changing state."""
    validate_operation(account, event_id)
    try:
        with engine.begin() as conn:
            return _completion_preview(conn, account, event_id)
    except (SQLAlchemyError, ValidationError) as exc:
        raise WorkError(503, "暂时无法核对事件") from exc


def _lookup(conn: Connection, account: str, operation_id: UUID) -> RowMapping | None:
    return (
        conn.execute(
            select(operations.c.fingerprint, operations.c.item_id).where(
                operations.c.account == account, operations.c.id == str(operation_id)
            )
        )
        .mappings()
        .one_or_none()
    )


def _decode(row: RowMapping) -> _LedgerPayload | None:
    raw: str = row["fingerprint"]
    if not raw.startswith(RECEIPT_PREFIX) or raw.startswith(_COMPLETE_PREFIX):
        return None
    result = _LedgerPayload.model_validate_json(raw[len(RECEIPT_PREFIX) :], strict=True)
    event = result.event
    if (
        event.model_fields_set != set(ItemOutput.model_fields)
        or event.id != row["item_id"]
        or event.type != "event"
        or not event.parent
        or event.version != 1
        or event.status != "notStarted"
    ):
        raise WorkError(503, _UNKNOWN)
    return result


def _decode_completion(row: RowMapping) -> _CompletionLedger | None:
    raw: str = row["fingerprint"]
    if not raw.startswith(_COMPLETE_PREFIX):
        return None
    result = _CompletionLedger.model_validate_json(raw[len(_COMPLETE_PREFIX) :], strict=True)
    if result.event.id != row["item_id"] or result.event.version < 2:
        raise WorkError(503, _UNKNOWN)
    return result


def _committed(
    conn: Connection, account: str, operation_id: UUID, *, verify_event: bool = False
) -> DirectReceipt:
    row = _lookup(conn, account, operation_id)
    result = _decode(row) if row is not None else None
    if result is None:
        raise WorkError(503, _UNKNOWN) if verify_event else WorkError(404, _NOT_FOUND)
    if verify_event and read_item(conn, account, result.event.id) != result.event:
        raise WorkError(503, _UNKNOWN)
    return DirectReceipt(event=result.event)


def receipt(engine: Engine, account: str, operation_id: UUID) -> DirectReceipt | CompletionReceipt:
    """Recover the exact Host-approved creation or completion, without replaying it."""
    validate_operation(account, operation_id)
    try:
        with engine.connect() as conn:
            row = _lookup(conn, account, operation_id)
            if row is not None:
                if completion := _decode_completion(row):
                    return CompletionReceipt(event=completion.event)
                if creation := _decode(row):
                    return DirectReceipt(event=creation.event)
            raise WorkError(404, _NOT_FOUND)
    except (SQLAlchemyError, ValidationError) as exc:
        raise WorkError(503, _UNKNOWN) from exc


def _write(conn: Connection, account: str, data: DirectInput, digest: str) -> bool:
    prior = _lookup(conn, account, data.operation_id)
    if prior is not None:
        result = _decode(prior)
        if result is None or result.digest != digest:
            raise WorkError(409, "操作标识已用于其他内容")
        return False
    # SQLite takes a write lock before lookup. PostgreSQL locks the full active chain.
    parent = conn.execute(
        _active_chain(account).where(_thing.c.id == data.thing_id).with_for_update()
    ).one_or_none()
    if (
        parent is None
        or parent[1] != data.expected_version
        or (parent[2], parent[3], parent[4]) != data.expected_path
    ):
        raise WorkError(409, _STALE)
    event_id = create_work(
        conn,
        account,
        ItemInput(
            type="event",
            parent=data.thing_id,
            name=data.title,
            owner=data.owner,
            planEnd=data.planned_date,
            description=data.description,
        ),
    )
    event = read_item(conn, account, event_id)
    if event is None:
        raise WorkError(503, _UNKNOWN)
    # The existing ledger has no snapshot column. Tag the fingerprint payload with a
    # source marker and retain the exact initial event there without a schema migration.
    record = _LedgerPayload(event=event, digest=digest).model_dump_json()
    conn.execute(
        insert(operations).values(
            account=account,
            id=str(data.operation_id),
            fingerprint=RECEIPT_PREFIX + record,
            item_id=event_id,
        )
    )
    return True


def _complete(conn: Connection, account: str, data: CompletionInput, digest: str) -> bool:
    prior = _lookup(conn, account, data.operation_id)
    if prior is not None:
        result = _decode_completion(prior)
        if result is None or result.digest != digest:
            raise WorkError(409, "操作标识已用于其他内容")
        return False

    event_id = str(data.event_id)
    current = _completion_preview(conn, account, data.event_id, lock=True)
    if (current.version, current.path, current.title, current.status) != (
        data.expected_version,
        data.expected_path,
        data.expected_title,
        data.expected_status,
    ):
        raise WorkError(409, "事件或归属已变化，请重新核对")
    guard_status(conn, account, event_id, "completed")
    changed = conn.execute(
        update(items)
        .where(
            items.c.account == account,
            items.c.id == event_id,
            items.c.type == "event",
            items.c.version == current.version,
            items.c.status == current.status,
            items.c.id.not_in(select(deletions.c.item_id)),
        )
        .values(status="completed", version=current.version + 1)
    )
    if changed.rowcount != 1:
        raise WorkError(409, "事件或归属已变化，请重新核对")
    pause_event_reminders(conn, account, event_id)
    record = _CompletionLedger(
        event=CompletedEvent(id=event_id, version=current.version + 1, name=current.title),
        digest=digest,
    ).model_dump_json()
    conn.execute(
        insert(operations).values(
            account=account,
            id=str(data.operation_id),
            item_id=event_id,
            fingerprint=_COMPLETE_PREFIX + record,
        )
    )
    return True


def complete(engine: Engine, account: str, data: CompletionInput) -> CompletionReceipt:
    """Commit the approved completion and its exact receipt together, then read back."""
    validate_operation(account, data.operation_id)
    digest = hashlib.sha256(data.model_dump_json().encode("utf-8")).hexdigest()
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            changed = _complete(conn, account, data, digest)
        with engine.connect() as conn:
            row = _lookup(conn, account, data.operation_id)
            result = _decode_completion(row) if row is not None else None
            if result is None:
                raise WorkError(503, _UNKNOWN)
            if changed:
                event = read_item(conn, account, result.event.id)
                if event is None or (event.type, event.status, event.version, event.name) != (
                    result.event.type,
                    result.event.status,
                    result.event.version,
                    result.event.name,
                ):
                    raise WorkError(503, _UNKNOWN)
            return CompletionReceipt(event=result.event)
    except IntegrityError as exc:
        raise WorkError(409, "写入发生冲突，请核对原操作") from exc
    except (SQLAlchemyError, ValidationError) as exc:
        raise WorkError(503, _UNKNOWN) from exc


def record(engine: Engine, account: str, data: DirectInput) -> DirectReceipt:
    """Create the event and receipt in one transaction, then verify stored results."""
    validate_operation(account, data.operation_id)
    digest = hashlib.sha256(data.model_dump_json().encode("utf-8")).hexdigest()
    try:
        with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            created = _write(conn, account, data, digest)
        with engine.connect() as conn:
            return _committed(conn, account, data.operation_id, verify_event=created)
    except IntegrityError as exc:
        raise WorkError(409, "写入发生冲突，请核对原操作") from exc
    except (SQLAlchemyError, ValidationError) as exc:
        raise WorkError(503, _UNKNOWN) from exc
