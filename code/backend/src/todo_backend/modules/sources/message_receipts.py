"""Persistent chat message identities, independent of polling pages and source UUIDs."""

import hashlib
import json

from sqlalchemy import Column, String, Table

from todo_backend.modules.work.repository import metadata

receipts = Table(
    "source_message_receipts",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("address", String(200), primary_key=True),
    Column("message_id", String(200), primary_key=True),
)


def chat_messages(content: str) -> dict[str, str]:
    """Decode stored CLI pages; retain whole-text identity for legacy plain snapshots."""
    if not content.startswith(("部分结果：仅当前最新一页\n", "当前页完整\n")):
        return {"legacy:" + hashlib.sha256(content.encode()).hexdigest(): content}
    messages = json.loads(content.split("\n", 1)[1])
    if not isinstance(messages, list):
        raise ValueError("invalid chat page")
    result: dict[str, str] = {}
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("invalid message")
        mid = message.get("message_id")
        if not isinstance(mid, str) or not mid.strip() or len(mid) > 200:
            raise ValueError("missing message identity")
        result[mid] = json.dumps(message, ensure_ascii=False, sort_keys=True)
    return result
