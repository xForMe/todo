"""Persist observed evidence changes before a polling page can hide them."""

from collections.abc import Mapping

from sqlalchemy import delete, select, text, update
from sqlalchemy.engine import Connection, RowMapping

from todo_backend.modules.memory.provenance import content_hash
from todo_backend.modules.memory.repository import candidates, jobs, origins
from todo_backend.modules.sources.message_receipts import chat_messages


def invalidate_changed_evidence(
    conn: Connection, source: Mapping[str, object] | RowMapping, content: str
) -> None:
    """Run under the account lock, atomically with a successfully claimed source snapshot.

    Missing stable message IDs mean paging, not deletion. A visible content mismatch is
    durable invalidation: a later page or restored text cannot reactivate the old proof.
    """
    account = str(source["account"])
    rows = (
        conn.execute(
            select(candidates).where(
                candidates.c.account == account,
                candidates.c.source_id == source["id"],
                candidates.c.state.in_(("pending", "accepted")),
            )
        )
        .mappings()
        .all()
    )
    if not rows:
        return
    snapshots = (str(source["content"]), content)
    if source["kind"] == "chat":
        # Include the replaced snapshot, in case the edit predates this code revision.
        pages = [chat_messages(snapshot) for snapshot in snapshots]
        invalid_ids = [
            row["id"]
            for row in rows
            if any(
                content_hash(page[row["message_id"]]) != row["content_hash"]
                if row["message_id"] in page
                else row["message_id"].startswith("legacy:")
                for page in pages
            )
        ]
    else:
        hashes = {content_hash(snapshot) for snapshot in snapshots}
        invalid_ids = [row["id"] for row in rows if hashes != {row["content_hash"]}]
    if not invalid_ids:
        return
    affected = (
        conn.execute(
            select(origins.c.module_id)
            .where(origins.c.account == account, origins.c.candidate_id.in_(invalid_ids))
            .distinct()
        )
        .scalars()
        .all()
    )
    conn.execute(
        update(candidates)
        .where(candidates.c.account == account, candidates.c.id.in_(invalid_ids))
        .values(state="invalid", body="")
    )
    for module_id in affected:
        conn.execute(
            text("DELETE FROM memory_vectors WHERE account=:a AND module_id=:m"),
            {"a": account, "m": module_id},
        )
        conn.execute(delete(jobs).where(jobs.c.account == account, jobs.c.module_id == module_id))
    actual = conn.execute(
        select(candidates.c.state, candidates.c.body).where(
            candidates.c.account == account, candidates.c.id.in_(invalid_ids)
        )
    ).all()
    if len(actual) != len(invalid_ids) or any(state != "invalid" or body for state, body in actual):
        raise RuntimeError("记忆失效结果读回失败")
