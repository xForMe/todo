"""Account-scoped read snapshot for the global workbench."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.engine import Engine

from todo_backend.modules.work.attention import attention
from todo_backend.modules.work.event_repository import branches, links
from todo_backend.modules.work.priority_repository import overview
from todo_backend.modules.work.repository import deletions, items
from todo_backend.modules.work.schemas import ItemOutput


def snapshot(engine: Engine, account: str) -> dict[str, object]:
    """Read all sections consistently without triggering external adapters."""
    with engine.connect() as conn, conn.begin():
        if engine.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN")
        visible = select(items.c.id).where(
            items.c.account == account, items.c.id.not_in(select(deletions.c.item_id))
        )
        work = [
            ItemOutput.model_validate({k: v for k, v in row.items() if k != "account"}).model_dump()
            for row in conn.execute(select(items).where(items.c.id.in_(visible))).mappings()
        ]
        flags = [
            dict(row)
            for row in conn.execute(
                select(attention).where(attention.c.item_id.in_(visible))
            ).mappings()
        ]
        tree = [
            dict(row)
            for row in conn.execute(
                select(branches.c.child_id, branches.c.parent_id).where(
                    branches.c.account == account,
                    branches.c.child_id.in_(visible),
                    branches.c.parent_id.in_(visible),
                )
            ).mappings()
        ]
        relations = [
            dict(row)
            for row in conn.execute(
                select(links.c.source, links.c.target, links.c.kind).where(
                    links.c.account == account,
                    links.c.source.in_(visible),
                    links.c.target.in_(visible),
                )
            ).mappings()
        ]
        return {
            "items": work,
            "attention": flags,
            "branches": tree,
            "links": relations,
            "priorities": overview(conn, account),
            "today": datetime.now(timezone(timedelta(hours=8))).date().isoformat(),
        }
