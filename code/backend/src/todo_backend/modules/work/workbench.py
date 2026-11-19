"""Account-scoped read snapshot for the global workbench."""

from sqlalchemy import select
from sqlalchemy.engine import Engine

from todo_backend.modules.work.attention import attention
from todo_backend.modules.work.daily_review import beijing_now, reviews
from todo_backend.modules.work.event_repository import branches, links, predecessors
from todo_backend.modules.work.priority_repository import overview
from todo_backend.modules.work.repository import deletions, items
from todo_backend.modules.work.schemas import ItemOutput


def snapshot(engine: Engine, account: str) -> dict[str, object]:
    """Read all sections consistently without triggering external adapters."""
    with engine.connect() as conn, conn.begin():
        today = beijing_now().date().isoformat()
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
            "daily_reviews": [
                dict(row)
                for row in conn.execute(
                    select(
                        reviews.c.item_id,
                        reviews.c.day,
                        reviews.c.reviewed_at,
                        reviews.c.revision,
                    ).where(
                        reviews.c.account == account,
                        reviews.c.day == today,
                        reviews.c.item_id.in_(visible),
                    )
                ).mappings()
            ],
            "items": work,
            "attention": flags,
            "branches": tree,
            "links": relations,
            "dependencies": [
                dict(row)
                for row in conn.execute(
                    select(predecessors.c.event_id, predecessors.c.predecessor_id)
                    .where(predecessors.c.account == account, predecessors.c.event_id.in_(visible))
                    .order_by(predecessors.c.event_id, predecessors.c.predecessor_id)
                ).mappings()
            ],
            "priorities": overview(conn, account),
            "today": today,
        }
