"""Explicitly scoped source writes, without external calls."""

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine

from todo_backend.modules.sources.repository import read_sources, sources
from todo_backend.modules.sources.schemas import SourceInput
from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.service import WorkError


def save_source(engine: Engine, account: str, data: SourceInput) -> dict[str, object]:
    """Write using UUID replay and optimistic version checks, then read back."""
    sid = str(data.id)
    values = data.model_dump(exclude={"id", "consent", "expected_version"})
    values["context"] = str(data.context) if data.context else ""
    with engine.begin() as conn:
        parent = read_item(conn, account, str(data.context))
        allowed = {"document": {"thing", "event"}, "chat": {"module"}}
        if data.kind == "document" and (parent is None or parent.type not in allowed[data.kind]):
            raise WorkError(404, "来源归属不存在或不可操作")
        if data.kind == "chat" and data.enabled:
            active = conn.execute(
                select(sources.c.id).where(
                    sources.c.account == account,
                    sources.c.kind == "chat",
                    sources.c.address == data.address,
                    sources.c.id != sid,
                    sources.c.enabled.is_(True),
                    sources.c.removed.is_(False),
                )
            ).first()
            if active:
                raise WorkError(409, "该聊天已有启用来源，请先暂停重复配置")
        current = conn.execute(select(sources).where(sources.c.id == sid)).mappings().first()
        if current:
            if current["account"] != account:
                raise WorkError(404, "来源不可操作")
            identical = all(current[key] == value for key, value in values.items())
            if not identical:
                if current["version"] != data.expected_version or current["removed"]:
                    raise WorkError(409, "来源已变化，请刷新后操作")
                changed = conn.execute(
                    update(sources)
                    .where(sources.c.id == sid, sources.c.version == data.expected_version)
                    .values(
                        **values,
                        version=current["version"] + 1,
                        next_run=0,
                        status="等待读取" if data.enabled else "已暂停",
                    )
                )
                if changed.rowcount != 1:
                    raise WorkError(409, "来源已变化，请刷新")
        else:
            if data.expected_version is not None:
                raise WorkError(409, "来源不存在，不能更新")
            duplicate = conn.execute(
                select(sources.c.id).where(
                    sources.c.account == account,
                    sources.c.context == values["context"],
                    sources.c.address == data.address,
                    sources.c.removed.is_(False),
                )
            ).first()
            if duplicate:
                raise WorkError(409, "当前上下文已关联此来源")
            conn.execute(
                insert(sources).values(
                    id=sid,
                    account=account,
                    **values,
                    version=1,
                    next_run=0,
                    last_run=0,
                    content="",
                    status="等待读取" if data.enabled else "已暂停",
                )
            )
    with engine.connect() as conn:
        result = next((r for r in read_sources(conn, account) if r["id"] == sid), None)
        if result is not None:
            return result
        removed = conn.execute(
            select(sources.c.removed).where(sources.c.id == sid, sources.c.account == account)
        ).scalar_one_or_none()
    if removed:
        return {"id": sid, "removed": True}
    raise WorkError(503, "结果待核对，请刷新来源列表")
