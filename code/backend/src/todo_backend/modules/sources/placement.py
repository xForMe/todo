"""User-confirmed hierarchy creation for chat suggestions, in one transaction."""

from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.client import Proposal
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError


class Placement(BaseModel):
    """Explicit selections; names are created only after the confirmation."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    goal_id: str
    module_id: str = ""
    new_module_name: str = Field(default="", max_length=120)
    new_thing_name: str = Field(default="", max_length=120)


def create_work(conn: Connection, account: str, value: ItemInput) -> str:
    """Insert a validated hierarchy node within the caller's transaction."""
    identifier = str(uuid4())
    conn.execute(
        insert(items).values(id=identifier, account=account, version=1, **value.model_dump())
    )
    return identifier


def create_named(conn: Connection, account: str, kind: str, parent: str, name: str) -> str:
    """Reject duplicate names under the selected parent rather than silently merging."""
    duplicate = conn.execute(
        select(items.c.id).where(
            items.c.account == account,
            items.c.parent == parent,
            items.c.name == name,
            items.c.type == kind,
            items.c.id.not_in(select(deletions.c.item_id)),
        )
    ).first()
    if duplicate:
        raise WorkError(409, "所选位置已有同名内容，请刷新后选择已有项")
    return create_work(
        conn, account, ItemInput.model_validate({"type": kind, "parent": parent, "name": name})
    )


def accept_new(
    engine: Engine,
    account: str,
    suggestion_id: str,
    edited: Proposal | None,
    placement: Placement | None,
) -> ItemOutput:
    """Create optional module/thing and the event atomically, then read back."""
    try:
        with engine.connect() as conn:
            if engine.dialect.name == "sqlite":
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            row = (
                conn.execute(
                    select(suggestions)
                    .where(suggestions.c.id == suggestion_id, suggestions.c.account == account)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if row is None:
                raise WorkError(404, "建议不存在")
            if row["state"] == "accepted" and row["event_id"]:
                event_id = str(row["event_id"])
            else:
                if row["state"] != "pending" or row["action"] != "new":
                    raise WorkError(409, "建议已变化，请核对结果")
                original = Proposal.model_validate_json(row["body"])
                proposal = edited or original
                if (
                    proposal.action != "new"
                    or proposal.event_id is not None
                    or proposal.evidence != original.evidence
                ):
                    raise WorkError(422, "不能修改来源依据或操作类型")
                source = (
                    conn.execute(
                        select(sources).where(
                            sources.c.id == row["source_id"], sources.c.account == account
                        )
                    )
                    .mappings()
                    .one()
                )
                if source["kind"] != "chat" and (
                    placement is not None or proposal.thing_id != original.thing_id
                ):
                    raise WorkError(422, "文档建议不能扩展原有事情范围")
                thing_id = proposal.thing_id
                if placement is not None:
                    thing_id = place(conn, account, proposal, placement)
                thing = read_item(conn, account, thing_id)
                if thing is None or thing.type != "thing":
                    raise WorkError(422, "请先确认所属事情")
                event_id = create_work(
                    conn,
                    account,
                    ItemInput(
                        type="event",
                        parent=thing_id,
                        name=proposal.name,
                        description=proposal.evidence,
                        owner=proposal.owner,
                        planEnd=proposal.plan_end,
                        status=proposal.status,
                    ),
                )
                proposal.thing_id = thing_id
                conn.execute(
                    update(suggestions)
                    .where(suggestions.c.id == suggestion_id)
                    .values(
                        thing_id=thing_id,
                        event_id=event_id,
                        body=proposal.model_dump_json(),
                        state="accepted",
                    )
                )
            conn.commit()
        with engine.connect() as conn:
            result = read_item(conn, account, event_id)
        if result is None:
            raise WorkError(503, "保存结果待核对")
        return result
    except SQLAlchemyError as exc:
        raise WorkError(503, "保存结果待核对，请保留原建议，不会自动重试") from exc


def place(conn: Connection, account: str, proposal: Proposal, placement: Placement) -> str:
    """Validate the full selected chain, creating only explicitly named nodes."""
    goal = read_item(conn, account, placement.goal_id)
    if goal is None or goal.type != "goal":
        raise WorkError(422, "请选择可用目标")
    if placement.module_id and placement.new_module_name:
        raise WorkError(422, "请选择已有模块或新建模块，不能同时指定")
    if proposal.thing_id and placement.new_thing_name:
        raise WorkError(422, "请选择已有事情或新建事情，不能同时指定")
    module_id = placement.module_id
    if placement.new_module_name:
        if not placement.new_thing_name:
            raise WorkError(422, "新模块下请填写新事情名称")
        module_id = create_named(conn, account, "module", goal.id, placement.new_module_name)
    module = read_item(conn, account, module_id)
    if module is None or module.type != "module" or module.parent != goal.id:
        raise WorkError(422, "模块不属于所选目标")
    if placement.new_thing_name:
        return create_named(conn, account, "thing", module.id, placement.new_thing_name)
    thing = read_item(conn, account, proposal.thing_id)
    if thing is None or thing.type != "thing" or thing.parent != module.id:
        raise WorkError(422, "事情不属于所选模块")
    return thing.id
