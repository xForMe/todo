"""Bounded module context with live scope checks before and after inference."""

import json
import os

from sqlalchemy import bindparam, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.embeddings import EmbeddingError, configuration, embed
from todo_backend.modules.memory.indexing import card_text
from todo_backend.modules.memory.repository import cards
from todo_backend.modules.memory.schemas import CardOutput, MemoryContext
from todo_backend.modules.memory.service import digest, enabled, read_card
from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.service import WorkError


def valid_cards(conn: Connection, account: str, context_id: str) -> list[CardOutput]:
    """Filter ownership, current scope, active status and document placement."""
    module_id = ""
    if context_id:
        context = read_item(conn, account, context_id)
        if context and context.type == "event":
            context = read_item(conn, account, context.parent or "")
        if context is None or context.type != "thing":
            return []
        module_id = context.parent or ""
    query = select(cards.c.module_id).where(cards.c.account == account, cards.c.enabled.is_(True))
    if module_id:
        query = query.where(cards.c.module_id == module_id)
    result = []
    for target in conn.execute(query.order_by(cards.c.module_id)).scalars():
        try:
            card = read_card(conn, account, target)
        except WorkError:
            continue
        if card.usable:
            result.append(card)
    return result


def fingerprint(conn: Connection, account: str, context_id: str) -> str:
    """Represent all eligible confirmed cards so late changes invalidate inference."""
    if not enabled():
        return ""
    return digest(
        "".join(card.model_dump_json() for card in valid_cards(conn, account, context_id))
    )


def memory_context(
    engine: Engine, account: str, content: str, context_id: str = ""
) -> MemoryContext:
    """Combine exact matches and optional native vector search, never caching queries."""
    if not enabled():
        return MemoryContext()
    with engine.connect() as conn:
        eligible = valid_cards(conn, account, context_id)
        stamp = digest("".join(card.model_dump_json() for card in eligible))
    exact = [
        card
        for card in eligible
        if any(term in content for term in [card.path.split(" / ")[-1], *card.aliases] if term)
    ]
    selected = exact[:10]
    status = "exact"
    if eligible and os.environ.get("TODO_EMBEDDING_SOURCE_CONSENT") == "1":
        try:
            config = configuration()
            if engine.dialect.name != "postgresql":
                raise EmbeddingError("语义检索需要 PostgreSQL + pgvector")
            vector = embed(content, config)
            allowed = {card.module_id: card for card in eligible}
            query = text(
                "SELECT v.module_id, v.revision FROM memory_vectors v JOIN memory_cards c "
                "ON c.account=v.account AND c.module_id=v.module_id AND c.version=v.revision "
                "WHERE v.account=:a AND v.profile=:p AND c.enabled=true "
                "AND v.module_id IN :ids ORDER BY v.embedding "
                "OPERATOR(public.<=>) CAST(:v AS public.vector) LIMIT 10"
            ).bindparams(bindparam("ids", expanding=True))
            with engine.connect() as conn:
                rows = conn.execute(
                    query,
                    {
                        "a": account,
                        "p": config.profile,
                        "ids": list(allowed),
                        "v": json.dumps(vector),
                    },
                ).mappings()
                for row in rows:
                    card = allowed[str(row["module_id"])]
                    if card.version == row["revision"] and card not in selected:
                        selected.append(card)
            status = "hybrid"
        except (EmbeddingError, SQLAlchemyError):
            status = "semantic_unavailable"
    if not selected:
        # Small bounded directory fallback avoids forcing semantic matches; facts are not rules.
        selected = eligible[:10]
    parts: list[str] = []
    length = 0
    for card in selected[:10]:
        part = json.dumps(
            {
                "module_id": card.module_id,
                "revision": card.version,
                "evidence": "用户确认的模块记忆",
                "content": card_text(card),
            },
            ensure_ascii=False,
        )
        part_length = len(part) + (1 if parts else 0)
        if length + part_length > 6000:
            status += ":partial"
            break
        parts.append(part)
        length += part_length
    if len(eligible) > len(selected) or len(selected) > 10:
        status += ":partial"
    with engine.connect() as conn:
        if fingerprint(conn, account, context_id) != stamp:
            raise WorkError(409, "记忆已变化，请重新识别")
    return MemoryContext(text="\n".join(parts), fingerprint=stamp, status=status)
