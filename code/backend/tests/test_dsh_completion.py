"""Exercise Host-approved completion against isolated To Do data."""

import hmac
import json
from typing import cast
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from test_dsh_capture import TOKEN, call, engine, tree, value
from test_dsh_direct import _DIRECT
from test_dsh_direct import enabled as enabled
from test_event_structure import body as children_body
from test_event_structure import status as edit_status
from test_work import payload

from todo_backend.modules.work.repository import items

_URL = "/api/dsh-direct/events/complete"
_DOMAIN = b"todo-direct-complete-v1\n"


def event(client: TestClient, parent: str) -> dict[str, str | int]:
    """Create one synthetic event with an unrelated field to preserve."""
    response = client.post(
        "/api/items", json={**payload("event", parent), "name": "合同编写", "description": "保留"}
    )
    assert response.status_code == 200, response.text
    result: dict[str, str | int] = response.json()
    return result


def approval(event_id: object, **overrides: object) -> dict[str, object]:
    """Build the exact operation reviewed by the synthetic Host."""
    return {
        "operation_id": str(uuid4()),
        "event_id": event_id,
        "expected_version": 1,
        "expected_title": "合同编写",
        "expected_path": ["交付", "接口", "联调准备"],
        "expected_status": "notStarted",
        **overrides,
    }


def post(
    client: TestClient, data: dict[str, object], domain: bytes = _DOMAIN, secret: str = _DIRECT
) -> Response:
    """Send a signed request with fake test-only credentials."""
    raw = json.dumps(data, ensure_ascii=False).encode()
    signature = hmac.digest(secret.encode(), domain + raw, "sha256").hex()
    return cast(
        Response,
        client.post(
            _URL,
            content=raw,
            headers={"Content-Type": "application/json", "X-Todo-Approval": f"v1={signature}"},
        ),
    )


def test_completion_and_original_receipt(enabled: TestClient) -> None:
    """Verify state, preserved fields, replay and source-specific recovery."""
    current = event(enabled, tree(enabled)[2])
    preview = value(call(enabled, "get_event_to_complete", {"event_id": current["id"]}))
    data = approval(current["id"])
    assert preview == {
        "event_id": current["id"],
        "title": "合同编写",
        "version": 1,
        "path": data["expected_path"],
        "status": "notStarted",
    }
    result = post(enabled, data)
    assert result.status_code == 200, result.text
    receipt = {
        "event": {
            "id": current["id"],
            "name": "合同编写",
            "type": "event",
            "status": "completed",
            "version": 2,
        }
    }
    assert result.json() == receipt
    assert post(enabled, data).json() == receipt
    assert post(enabled, {**data, "expected_title": "其他"}).status_code == 409
    assert (
        value(call(enabled, "get_recorded_event", {"operation_id": data["operation_id"]}))
        == receipt
    )
    assert enabled.get(f"/api/operations/{data['operation_id']}").status_code == 404
    with engine(enabled).connect() as conn:
        row = conn.execute(select(items).where(items.c.id == current["id"])).mappings().one()
        assert (row["status"], row["version"], row["description"]) == ("completed", 2, "保留")
    assert (
        call(enabled, "get_event_to_complete", {"event_id": current["id"]}).get("isError") is True
    )
    assert edit_status(enabled, str(current["id"]), "working") == 200
    assert post(enabled, data).json() == receipt
    with engine(enabled).connect() as conn:
        assert conn.scalar(select(items.c.status).where(items.c.id == current["id"])) == "working"


def test_open_child_blocks_completion(enabled: TestClient) -> None:
    """Reuse the existing rule for unfinished descendant events."""
    _, _, matter = tree(enabled)
    current = event(enabled, matter)
    event_id = str(current["id"])
    path = f"/api/events/{event_id}/children"
    children = enabled.post(path, json=children_body(enabled, {"event": event_id, "thing": matter}))
    assert children.status_code == 200, children.text
    data = approval(event_id)
    result = post(enabled, data)
    assert result.status_code == 409 and "未结束子事件" in result.text
    assert (
        call(enabled, "get_recorded_event", {"operation_id": data["operation_id"]}).get("isError")
        is True
    )
    with engine(enabled).connect() as conn:
        assert conn.scalar(select(items.c.status).where(items.c.id == event_id)) == "notStarted"


def test_completion_rejects_unapproved_stale_and_foreign(
    enabled: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The query token, creation signature and stale approval cannot write."""
    current = event(enabled, tree(enabled)[2])
    data = approval(current["id"])
    assert (
        enabled.post(_URL, json=data, headers={"Authorization": f"Bearer {TOKEN}"}).status_code
        == 401
    )
    assert post(enabled, data, secret=TOKEN).status_code == 401
    assert post(enabled, data, b"todo-direct-create-v1\n").status_code == 401
    assert post(enabled, {**data, "expected_path": ["交付", "接口", "其他"]}).status_code == 409
    assert post(enabled, {**data, "expected_version": 2}).status_code == 409
    monkeypatch.setenv("TODO_OWNER_ID", "foreign")
    assert post(enabled, data).status_code == 404
    with engine(enabled).connect() as conn:
        assert (
            conn.scalar(select(items.c.status).where(items.c.id == current["id"])) == "notStarted"
        )
