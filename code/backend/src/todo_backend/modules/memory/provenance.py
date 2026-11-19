"""Live source proofs for pending and confirmed memory; never infer authorization from text."""

import hashlib
import json
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.engine import Connection, RowMapping

from todo_backend.modules.memory.repository import candidates, origins
from todo_backend.modules.sources.discarding import discard_key
from todo_backend.modules.sources.message_receipts import chat_messages, receipts
from todo_backend.modules.sources.repository import sources
from todo_backend.modules.work.repository import read_item


def content_hash(value: str) -> str:
    """Fingerprint exact source snapshots without another plaintext copy."""
    return hashlib.sha256(value.encode()).hexdigest()


def source_scope(source: Mapping[str, object] | RowMapping) -> str:
    """Bind proof to the source configuration as well as its version."""
    return content_hash(json.dumps([source[key] for key in ("kind", "address", "context")]))


def proof_valid(conn: Connection, row: Mapping[str, object] | RowMapping, pending: bool) -> bool:
    """Reject withdrawn, discarded, edited or rebound evidence before returning any content."""
    source = (
        conn.execute(
            select(sources).where(
                sources.c.account == row["account"], sources.c.id == row["source_id"]
            )
        )
        .mappings()
        .first()
    )
    if (
        source is None
        or not source["enabled"]
        or source["removed"]
        or not source["ai_consent"]
        or source["version"] != row["source_version"]
        or source_scope(source) != row["source_scope"]
    ):
        return False
    if source["kind"] != "chat":
        parent = read_item(conn, str(row["account"]), str(source["context"]))
        if parent and parent.type == "event":
            parent = read_item(conn, str(row["account"]), parent.parent or "")
        return bool(
            parent
            and parent.type == "thing"
            and parent.parent == row["module_id"]
            and content_hash(source["content"]) == row["content_hash"]
        )
    if conn.execute(
        select(receipts.c.message_id).where(
            receipts.c.account == row["account"],
            receipts.c.address == source["address"],
            receipts.c.message_id == discard_key(str(row["message_id"])),
        )
    ).first():
        return False
    try:
        raw = chat_messages(source["content"]).get(str(row["message_id"]))
    except (ValueError, TypeError):
        return False
    if raw is None and str(row["message_id"]).startswith("legacy:"):
        # Plain snapshots have no stable message identity: absence cannot prove retained history.
        return False
    return content_hash(raw) == row["content_hash"] if raw is not None else not pending


def origins_valid(conn: Connection, account: str, module_id: str) -> bool:
    """All retained dependencies must be valid; partial revocation invalidates the whole card."""
    links = (
        conn.execute(
            select(origins.c.candidate_id).where(
                origins.c.account == account, origins.c.module_id == module_id
            )
        )
        .scalars()
        .all()
    )
    for candidate_id in links:
        row = (
            conn.execute(
                select(candidates).where(
                    candidates.c.account == account, candidates.c.id == candidate_id
                )
            )
            .mappings()
            .first()
        )
        if row is None or row["state"] != "accepted" or not proof_valid(conn, row, pending=False):
            return False
    return True
