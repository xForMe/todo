"""Source-grounded candidate admission and explicit confirmation, without automatic indexing."""

import json
from collections.abc import Mapping
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import Connection, Engine, RowMapping

from todo_backend.integrations.ai.client import MemoryDraft
from todo_backend.modules.memory.provenance import content_hash, proof_valid, source_scope
from todo_backend.modules.memory.repository import candidates, origins
from todo_backend.modules.memory.schemas import CardInput
from todo_backend.modules.memory.service import lock_account, read_card, require_enabled
from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.service import WorkError

MAX_CANDIDATES = 500


def collect(
    conn: Connection,
    source: Mapping[str, object] | RowMapping,
    drafts: list[MemoryDraft],
    content: str,
    pending: dict[str, str],
) -> tuple[int, bool]:
    """Admit at most five proven facts under the recognition transaction's account lock."""
    account = str(source["account"])
    count = conn.execute(
        select(func.count()).select_from(candidates).where(candidates.c.account == account)
    ).scalar_one()
    added, full = 0, False
    for draft in drafts[:5]:
        if draft.evidence not in content or any(
            alias not in draft.evidence for alias in draft.aliases
        ):
            continue
        target = read_item(conn, account, draft.module_id)
        if target is None or target.type != "module":
            continue
        try:
            card = read_card(conn, account, draft.module_id)
        except WorkError:
            continue
        raw, message_id = str(source["content"]), ""
        if source["kind"] == "chat":
            terms = [target.name, *(card.aliases if card.usable else [])]
            if not any(term in draft.evidence for term in terms if term):
                continue
            matches = [(mid, value) for mid, value in pending.items() if draft.evidence in value]
            if len(matches) != 1:
                continue
            message_id, raw = matches[0]
        body = draft.model_dump_json()
        fact = content_hash(
            json.dumps(
                [
                    source["id"],
                    source_scope(source),
                    message_id,
                    draft.module_id,
                    draft.kind,
                    draft.description,
                    draft.aliases,
                    draft.evidence,
                ],
                ensure_ascii=False,
            )
        )
        candidate_id = str(uuid5(NAMESPACE_URL, fact + str(source["version"]) + content_hash(raw)))
        if conn.execute(
            select(candidates.c.id).where(
                candidates.c.account == account,
                (
                    (candidates.c.id == candidate_id)
                    | ((candidates.c.fact_hash == fact) & (candidates.c.state == "rejected"))
                ),
            )
        ).first():
            continue
        values = dict(
            account=account,
            id=candidate_id,
            module_id=draft.module_id,
            fact_hash=fact,
            source_id=source["id"],
            source_version=source["version"],
            source_scope=source_scope(source),
            message_id=message_id,
            content_hash=content_hash(raw),
            body=body,
            state="pending",
        )
        if not proof_valid(conn, values, pending=True):
            continue
        # read_card above already checked the module and goal in this transaction.
        if count >= MAX_CANDIDATES:
            full = True
            continue
        conn.execute(insert(candidates).values(**values))
        actual = conn.execute(
            select(candidates.c.body).where(
                candidates.c.account == account, candidates.c.id == candidate_id
            )
        ).scalar_one()
        if actual != body:
            raise WorkError(409, "候选写入结果待核对")
        count += 1
        added += 1
    return added, full


def list_candidates(conn: Connection, account: str, module_id: str = "") -> dict[str, object]:
    """Return at most 100 pending drafts; redact any no-longer-usable source material."""
    require_enabled()
    query = select(candidates).where(
        candidates.c.account == account, candidates.c.state == "pending"
    )
    if module_id:
        query = query.where(candidates.c.module_id == module_id)
    rows = conn.execute(query.order_by(candidates.c.id).limit(101)).mappings().all()
    result = []
    for row in rows[:100]:
        try:
            card = read_card(conn, account, row["module_id"])
        except WorkError:
            continue
        usable = proof_valid(conn, row, pending=True)
        draft = MemoryDraft.model_validate_json(row["body"]) if usable else None
        merged = list(dict.fromkeys([*card.aliases, *(draft.aliases if draft else [])]))
        result.append(
            {
                "id": row["id"],
                "module_id": row["module_id"],
                "path": card.path,
                "source_id": row["source_id"],
                "usable": usable,
                "status": "待核对" if usable else "来源已变化或不在当前页，原文不再展示",
                "draft": draft.model_dump() if draft else None,
                "current": card.model_dump() if usable else None,
                "description": (draft.description or card.description) if draft else "",
                "aliases": merged if usable else [],
            }
        )
    count = conn.execute(
        select(func.count()).select_from(candidates).where(candidates.c.account == account)
    ).scalar_one()
    return {"items": result, "partial": len(rows) > 100, "capacity_full": count >= MAX_CANDIDATES}


def prepare_confirmation(conn: Connection, account: str, module_id: str, data: CardInput) -> None:
    """Validate the proposed dependency before the card's atomic save; no external I/O."""
    row = (
        conn.execute(
            select(candidates).where(
                candidates.c.account == account,
                candidates.c.id == str(data.candidate_id),
                candidates.c.module_id == module_id,
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise WorkError(404, "记忆候选不存在或不可访问")
    if row["state"] != "pending" or not proof_valid(conn, row, pending=True):
        raise WorkError(409, "候选或来源已变化，请刷新核对")
    if not data.enabled:
        raise WorkError(422, "候选确认不能同时停用模块记忆")
    # Rebind only the SAME fact. Other facts from this source retain their own dependencies.
    old = select(candidates.c.id).where(
        candidates.c.account == account,
        candidates.c.source_id == row["source_id"],
        candidates.c.fact_hash == row["fact_hash"],
    )
    conn.execute(
        delete(origins).where(
            origins.c.account == account,
            origins.c.module_id == module_id,
            origins.c.candidate_id.in_(old),
        )
    )
    count = conn.execute(
        select(func.count())
        .select_from(origins)
        .where(origins.c.account == account, origins.c.module_id == module_id)
    ).scalar_one()
    if count >= 20:
        raise WorkError(409, "模块记忆来源已达上限，未确认")
    conn.execute(
        insert(origins).values(account=account, module_id=module_id, candidate_id=row["id"])
    )
    conn.execute(
        update(candidates)
        .where(candidates.c.account == account, candidates.c.id == row["id"])
        .values(state="accepted")
    )


def reject_candidate(engine: Engine, account: str, candidate_id: str) -> str:
    """Reject idempotently; keep the minimal bounded suppression record."""
    require_enabled()
    with engine.begin() as conn:
        lock_account(conn, account)
        row = conn.execute(
            select(candidates.c.state).where(
                candidates.c.account == account, candidates.c.id == candidate_id
            )
        ).scalar_one_or_none()
        if row is None:
            raise WorkError(404, "候选不存在或不可访问")
        if row == "accepted":
            raise WorkError(409, "候选已确认，请从模块记忆入口修改或停用")
        conn.execute(
            update(candidates)
            .where(candidates.c.account == account, candidates.c.id == candidate_id)
            .values(state="rejected", body="")
        )
    with engine.connect() as conn:
        actual = conn.execute(
            select(candidates.c.state).where(
                candidates.c.account == account, candidates.c.id == candidate_id
            )
        ).scalar_one()
        if actual != "rejected":
            raise WorkError(409, "拒绝结果待核对，请刷新")
    return "rejected"
