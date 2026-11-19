"""Bounded factual working memory; one current cache, no model calls or vectors."""

import time

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import Connection, Engine

from todo_backend.modules.memory.repository import working_summaries as cache
from todo_backend.modules.memory.schemas import WorkingAction, WorkingOutput, WorkingSummary
from todo_backend.modules.memory.service import digest, lock_account, module_scope, require_enabled
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemOutput
from todo_backend.modules.work.service import WorkError

POLICY = "business-fields-v1"
MAX_SUMMARIES = 1000
MAX_BODY = 4000
ACTIVE = {"notStarted", "working"}


def snapshot(conn: Connection, account: str, thing_id: str) -> tuple[WorkingSummary, str]:
    """Read current authorized facts, including omitted events in the freshness hash."""
    thing = read_item(conn, account, thing_id)
    if thing is None or thing.type != "thing":
        raise WorkError(404, "事情不存在或不可访问")
    path, scope = module_scope(conn, account, thing.parent or "")
    events = [
        ItemOutput.model_validate({k: v for k, v in row.items() if k != "account"})
        for row in conn.execute(
            select(items)
            .where(
                items.c.account == account,
                items.c.parent == thing_id,
                items.c.type == "event",
                items.c.id.not_in(select(deletions.c.item_id)),
            )
            .order_by(items.c.id)
        ).mappings()
    ]
    stamp = digest(
        POLICY
        + scope
        + thing.model_dump_json()
        + "".join(event.model_dump_json() for event in events)
    )
    counts = {
        state: sum(event.status == state for event in events)
        for state in ("notStarted", "working", "completed", "cancelled")
    }
    unfinished = sorted(
        (event for event in events if event.status in ACTIVE),
        key=lambda event: (
            not bool(event.planEnd),
            event.planEnd,
            event.status != "working",
            event.id,
        ),
    )
    summary = WorkingSummary(
        thing_id=thing_id,
        thing_version=thing.version,
        path=path + " / " + thing.name,
        status=thing.status,
        counts=counts,
        actions=[],
        omitted=len(unfinished),
        partial=False,
    )
    # Descriptions may be copied source evidence. Do not re-submit them without provenance checks.
    for event in unfinished[:10]:
        action = WorkingAction(
            id=event.id,
            version=event.version,
            name=event.name,
            status=event.status,
            owner=event.owner,
            plan_end=event.planEnd,
        )
        summary.actions.append(action)
        summary.omitted -= 1
        if len(summary.model_dump_json()) > MAX_BODY:
            summary.actions.pop()
            summary.omitted += 1
            break
    summary.partial |= summary.omitted > 0
    return summary, stamp


def prune_inactive(conn: Connection, account: str) -> None:
    """Remove only rebuildable cache rows whose live ancestry is gone or thing ended."""
    thing = items.alias("summary_thing")
    module = items.alias("summary_module")
    goal = items.alias("summary_goal")
    live = (
        select(thing.c.id)
        .select_from(
            thing.join(module, thing.c.parent == module.c.id).join(
                goal, module.c.parent == goal.c.id
            )
        )
        .where(
            thing.c.account == account,
            module.c.account == account,
            goal.c.account == account,
            thing.c.type == "thing",
            module.c.type == "module",
            goal.c.type == "goal",
            thing.c.status.in_(ACTIVE),
            thing.c.id.not_in(select(deletions.c.item_id)),
            module.c.id.not_in(select(deletions.c.item_id)),
            goal.c.id.not_in(select(deletions.c.item_id)),
        )
    )
    conn.execute(delete(cache).where(cache.c.account == account, cache.c.thing_id.not_in(live)))
    if conn.execute(
        select(cache.c.thing_id).where(cache.c.account == account, cache.c.thing_id.not_in(live))
    ).first():
        raise WorkError(409, "已结束摘要清理结果待核对")


def refresh_working(engine: Engine, account: str, thing_id: str) -> WorkingOutput:
    """Refresh deterministically under account lock; recheck facts after committing."""
    require_enabled()
    with engine.begin() as conn:
        lock_account(conn, account)
        summary, stamp = snapshot(conn, account, thing_id)
        prune_inactive(conn, account)
        result = WorkingOutput(
            thing_id=thing_id, state="inactive", fingerprint=stamp, generated_at=0
        )
        if summary.status in ACTIVE:
            current = (
                conn.execute(
                    select(cache).where(cache.c.account == account, cache.c.thing_id == thing_id)
                )
                .mappings()
                .first()
            )
            generated = int(time.time())
            state = "cached"
            body = summary.model_dump_json()
            if current and current["fingerprint"] == stamp and current["policy"] == POLICY:
                # Never trust a damaged stored body just because its metadata still matches.
                if current["body"] == body:
                    generated = current["generated_at"]
                else:
                    conn.execute(
                        update(cache)
                        .where(cache.c.account == account, cache.c.thing_id == thing_id)
                        .values(body=body, generated_at=generated)
                    )
            elif current:
                conn.execute(
                    update(cache)
                    .where(cache.c.account == account, cache.c.thing_id == thing_id)
                    .values(fingerprint=stamp, policy=POLICY, body=body, generated_at=generated)
                )
            elif (
                conn.execute(
                    select(func.count()).select_from(cache).where(cache.c.account == account)
                ).scalar_one()
                < MAX_SUMMARIES
            ):
                conn.execute(
                    insert(cache).values(
                        account=account,
                        thing_id=thing_id,
                        fingerprint=stamp,
                        policy=POLICY,
                        body=body,
                        generated_at=generated,
                    )
                )
            else:
                state = "capacity_uncached"
            result = WorkingOutput(
                thing_id=thing_id,
                state=state,
                fingerprint=stamp,
                generated_at=generated,
                summary=summary,
            )
    with engine.connect() as check:
        _, latest = snapshot(check, account, thing_id)
        if latest != stamp:
            raise WorkError(409, "工作内容已变化，请重新读取摘要")
        stored = check.execute(
            select(cache.c.body).where(cache.c.account == account, cache.c.thing_id == thing_id)
        ).scalar_one_or_none()
        if result.state == "cached" and stored != summary.model_dump_json():
            raise WorkError(409, "摘要结果待核对，请手动刷新")
        if result.state == "inactive" and stored is not None:
            raise WorkError(409, "摘要退出结果待核对，请手动刷新")
    return result
