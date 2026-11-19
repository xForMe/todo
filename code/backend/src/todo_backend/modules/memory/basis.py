"""Verified explicit memory citations; retrieval alone is not a model citation."""

import json

from sqlalchemy import func, insert, select
from sqlalchemy.engine import Connection

from todo_backend.integrations.ai.client import MemoryRef, Proposal
from todo_backend.modules.memory.repository import suggestion_refs
from todo_backend.modules.memory.service import read_card, require_enabled
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.service import WorkError

MAX_REFERENCES = 10000


def verified_refs(proposal: Proposal, attached: str, context: str) -> list[MemoryRef]:
    """Keep only module/revision pairs that really entered this inference's prompt."""
    if not attached or attached not in context:
        return []
    supplied = {
        (row["module_id"], row["revision"])
        for line in attached.splitlines()
        if (row := json.loads(line))
    }
    result = []
    seen = set()
    for ref in proposal.memory_refs:
        key = (ref.module_id, ref.revision)
        if key not in supplied or key in seen:
            continue
        if proposal.module_id and proposal.module_id != ref.module_id:
            continue
        seen.add(key)
        result.append(ref)
    return result


def store_refs(conn: Connection, account: str, sid: str, refs: list[MemoryRef]) -> bool:
    """Persist only IDs and versions in the same transaction as the source suggestion."""
    count = conn.execute(
        select(func.count())
        .select_from(suggestion_refs)
        .where(suggestion_refs.c.account == account)
    ).scalar_one()
    if count + len(refs) > MAX_REFERENCES:
        return False
    for ref in refs:
        conn.execute(
            insert(suggestion_refs).values(
                account=account, suggestion_id=sid, module_id=ref.module_id, revision=ref.revision
            )
        )
    return True


def suggestion_basis(conn: Connection, account: str, sid: str) -> dict[str, object]:
    """Read citations without leaking withdrawn source-derived content or stale card versions."""
    require_enabled()
    source = (
        conn.execute(
            select(sources)
            .join(suggestions, suggestions.c.source_id == sources.c.id)
            .where(
                suggestions.c.account == account,
                suggestions.c.id == sid,
                sources.c.account == account,
            )
        )
        .mappings()
        .first()
    )
    if source is None:
        raise WorkError(404, "建议不存在或不可访问")
    refs = (
        conn.execute(
            select(suggestion_refs).where(
                suggestion_refs.c.account == account, suggestion_refs.c.suggestion_id == sid
            )
        )
        .mappings()
        .all()
    )
    result = []
    authorized = source["enabled"] and source["ai_consent"] and not source["removed"]
    for ref in refs:
        try:
            card = read_card(conn, account, ref["module_id"])
        except WorkError:
            card = None
        valid = bool(authorized and card and card.usable and card.version == ref["revision"])
        result.append(
            {
                "module_id": ref["module_id"],
                "revision": ref["revision"],
                "valid": valid,
                "path": card.path if valid and card else "",
                "description": card.description if valid and card else "",
                "aliases": card.aliases if valid and card else [],
                "status": "当前有效" if valid else "引用版本或授权已失效，正文不再展示",
            }
        )
    return {"items": result, "note": "模型明确报告且经服务端核对的引用，不代表完整内部推理"}
