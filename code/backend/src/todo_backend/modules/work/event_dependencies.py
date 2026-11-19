"""Scope and cycle checks for explicitly configured finish-to-start edges."""

from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Connection

from todo_backend.modules.work.event_repository import branches, predecessors
from todo_backend.modules.work.repository import deletions, items
from todo_backend.modules.work.schemas import ItemOutput
from todo_backend.modules.work.service import WorkError


def scoped_events(conn: Connection, account: str, matter_id: str | None) -> dict[str, ItemOutput]:
    """Return visible work events in the current matter."""
    rows = conn.execute(
        select(items).where(
            items.c.account == account,
            items.c.parent == matter_id,
            items.c.type == "event",
            items.c.id.not_in(select(deletions.c.item_id)),
        )
    ).mappings()
    return {
        row["id"]: ItemOutput.model_validate({k: v for k, v in row.items() if k != "account"})
        for row in rows
    }


def blocked_targets(
    conn: Connection, account: str, current: str, visible: Iterable[str]
) -> set[str]:
    """Find targets that would make current depend on its own completion."""
    reverse: dict[str, list[str]] = defaultdict(list)
    ids = set(visible)
    for dependent, predecessor in conn.execute(
        select(predecessors.c.event_id, predecessors.c.predecessor_id).where(
            predecessors.c.account == account,
            predecessors.c.event_id.in_(ids),
            predecessors.c.predecessor_id.in_(ids),
        )
    ):
        reverse[predecessor].append(dependent)
    for child, parent in conn.execute(
        select(branches.c.child_id, branches.c.parent_id).where(
            branches.c.account == account, branches.c.child_id.in_(ids)
        )
    ):
        reverse[child].append(parent)
    reached = {current}
    pending = [current]
    while pending:
        for dependent in reverse[pending.pop()]:
            if dependent not in reached:
                reached.add(dependent)
                pending.append(dependent)
    return reached


def replace(conn: Connection, account: str, current: ItemOutput, requested: list[str]) -> None:
    """Replace reviewed edges atomically, keeping unchanged stale edges resolvable."""
    if len(requested) != len(set(requested)):
        raise WorkError(422, "前置事件不能重复")
    if current.id in requested:
        raise WorkError(422, "事件不能把自身设为前置")
    query = predecessors.c.account == account, predecessors.c.event_id == current.id
    prior = set(conn.execute(select(predecessors.c.predecessor_id).where(*query)).scalars())
    added = set(requested) - prior
    if added:
        candidates = scoped_events(conn, account, current.parent)
        if current.status in ("completed", "cancelled"):
            raise WorkError(409, "请先重开当前事件再添加前置")
        if any(
            target not in candidates or candidates[target].status == "cancelled" for target in added
        ):
            raise WorkError(422, "请选择同一事情下仍可用的前置事件")
        if added & blocked_targets(conn, account, current.id, candidates):
            raise WorkError(409, "该前置将形成循环，或与父子事件的完成顺序冲突")
    removed = prior - set(requested)
    if removed:
        conn.execute(delete(predecessors).where(*query, predecessors.c.predecessor_id.in_(removed)))
    if added:
        conn.execute(
            insert(predecessors),
            [
                {"event_id": current.id, "predecessor_id": target, "account": account}
                for target in sorted(added)
            ],
        )
