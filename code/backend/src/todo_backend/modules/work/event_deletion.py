"""Leaf-event deletion preserves evidence and explicitly stops automation."""

from sqlalchemy import delete, or_, select, update
from sqlalchemy.engine import Connection

from todo_backend.modules.sources.follow import rules
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.event_repository import branches, links
from todo_backend.modules.work.repository import deletions
from todo_backend.modules.work.service import WorkError


def relations(conn: Connection, account: str, item_id: str) -> list[dict[str, object]]:
    """Reject parent deletion and capture relationship history for review."""
    children = conn.execute(
        select(branches.c.child_id).where(
            branches.c.account == account,
            branches.c.parent_id == item_id,
            branches.c.child_id.not_in(select(deletions.c.item_id)),
        )
    ).first()
    if children:
        raise WorkError(409, "存在子事件，请先迁移或处理子事件，再删除当前事件")
    result = [
        dict(row)
        for row in conn.execute(
            select(branches).where(branches.c.account == account, branches.c.child_id == item_id)
        ).mappings()
    ]
    result.extend(
        dict(row)
        for row in conn.execute(
            select(links).where(
                links.c.account == account,
                or_(links.c.source == item_id, links.c.target == item_id),
            )
        ).mappings()
    )
    return result


def detach(conn: Connection, account: str, item_id: str, thing_id: str) -> None:
    """Keep records and provenance while removing active links atomically."""
    conn.execute(
        update(sources)
        .where(sources.c.account == account, sources.c.context == item_id)
        .values(
            context=thing_id,
            enabled=False,
            version=sources.c.version + 1,
            status="事件已删除，资料保留到所属事情，请核对后恢复",
        )
    )
    conn.execute(
        update(suggestions)
        .where(
            suggestions.c.account == account,
            suggestions.c.event_id == item_id,
            suggestions.c.state.in_(["pending", "linked"]),
        )
        .values(state="discarded")
    )
    conn.execute(
        update(rules)
        .where(rules.c.account == account, rules.c.event_id == item_id)
        .values(enabled=False, version=rules.c.version + 1, status="事件已删除，催办已暂停")
    )
    conn.execute(
        delete(branches).where(branches.c.account == account, branches.c.child_id == item_id)
    )
    conn.execute(
        delete(links).where(
            links.c.account == account,
            or_(links.c.source == item_id, links.c.target == item_id),
        )
    )
