from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient

from todo_backend.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "events.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as value:
        value.get("/api/session", headers={"X-Todo-Client": "web"})
        yield value


def seed(client: TestClient) -> dict[str, str]:
    ids: dict[str, str] = {}
    parent = None
    for kind in ("goal", "module", "thing", "event"):
        response = client.post(
            "/api/items",
            json={"type": kind, "parent": parent, "name": kind, "operation_id": str(uuid4())},
        )
        assert response.status_code == 200, response.text
        parent = response.json()["id"]
        ids[kind] = parent
    return ids


def body(client: TestClient, ids: dict[str, str], name: str = "子事件") -> dict[str, object]:
    view = client.get(f"/api/events/{ids['event']}/structure").json()
    return {
        "action": "children",
        "snapshot": view["snapshot"],
        "operation_id": str(uuid4()),
        "children": [{"type": "event", "parent": ids["thing"], "name": name}],
    }


def status(client: TestClient, event_id: str, value: str) -> int:
    row = next(r for r in client.get("/api/items").json() if r["id"] == event_id)
    row.pop("id")
    row["expected_version"] = row.pop("version")
    row["status"] = value
    row["operation_id"] = str(uuid4())
    return int(client.put("/api/items/" + event_id, json=row).status_code)


def test_multilevel_completion_and_reopen(client: TestClient) -> None:
    ids = seed(client)
    request = body(client, ids)
    path = f"/api/events/{ids['event']}/children"
    result = client.post(path, json=request)
    assert result.status_code == 200, result.text
    child = result.json()["created"][0]
    assert client.post(path, json=request).json() == result.json()
    assert (
        client.get("/api/event-operations/" + str(request["operation_id"])).json() == result.json()
    )
    assert status(client, ids["event"], "completed") == 409
    nested = {**ids, "event": child}
    grandchild = client.post(f"/api/events/{child}/children", json=body(client, nested)).json()[
        "created"
    ][0]
    assert status(client, child, "completed") == 409
    assert status(client, grandchild, "cancelled") == 200
    assert status(client, child, "completed") == 200
    assert status(client, ids["event"], "completed") == 200
    assert status(client, grandchild, "notStarted") == 409
    assert status(client, ids["event"], "notStarted") == 200
    assert status(client, child, "notStarted") == 200
    assert status(client, grandchild, "notStarted") == 200


def test_replay_conflict_snapshot_and_atomic_failure(client: TestClient) -> None:
    ids = seed(client)
    path = f"/api/events/{ids['event']}/children"
    request = body(client, ids)
    invalid = {
        **request,
        "children": [
            {"type": "event", "parent": ids["thing"], "name": "first"},
            {"type": "event", "parent": "missing", "name": "second"},
        ],
    }
    assert client.post(path, json=invalid).status_code == 422
    assert len(client.get("/api/items").json()) == 4
    assert client.post(path, json=request).status_code == 200
    assert client.post(path, json={**request, "kind": "followup"}).status_code == 409
    assert client.post(path, json={**request, "operation_id": str(uuid4())}).status_code == 409
    assert len(client.get("/api/items").json()) == 5


def test_followup_links_scope_and_remove(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = seed(client)
    assert status(client, ids["event"], "completed") == 200
    request = {**body(client, ids), "action": "followup"}
    path = f"/api/events/{ids['event']}/children"
    result = client.post(path, json=request)
    assert result.status_code == 200
    view = client.get(f"/api/events/{ids['event']}/structure").json()
    assert not view["branches"]
    assert len(view["links"]) == 1
    link = view["links"][0]
    remove = {
        "action": "unlink",
        "target": link["id"],
        "snapshot": view["snapshot"],
        "operation_id": str(uuid4()),
    }
    assert client.post(path, json=remove).status_code == 200
    assert len(client.get("/api/items").json()) == 5
    row = next(r for r in client.get("/api/items").json() if r["id"] == ids["event"])
    assert row["status"] == "completed"
    other = seed(client)
    view = client.get(f"/api/events/{ids['event']}/structure").json()
    invalid = {
        "action": "link",
        "target": other["event"],
        "snapshot": view["snapshot"],
        "operation_id": str(uuid4()),
    }
    assert client.post(path, json=invalid).status_code == 422
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get(f"/api/events/{ids['event']}/structure").status_code == 404
    assert client.post(path, json=request).status_code == 404
    assert client.get("/api/event-operations/" + str(request["operation_id"])).status_code == 404


def test_ai_consent_output_and_no_write(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.work import decomposition

    ids = seed(client)
    snapshot = body(client, ids)["snapshot"]
    path = f"/api/events/{ids['event']}/decomposition"
    request = {"consent": False, "snapshot": snapshot}
    assert client.post(path, json=request).status_code == 422
    calls: list[str] = []

    def fake(prompt: str, content: str, context: str) -> object:
        calls.append(context)
        return {"suggestions": [{"name": "确认边界", "reason": "建立验收依据"}]}

    monkeypatch.setattr(decomposition, "call_json", fake)
    request["consent"] = True
    assert client.post(path, json=request).status_code == 200
    assert calls and "goal" not in calls[0]
    assert len(client.get("/api/items").json()) == 4
    monkeypatch.setattr(decomposition, "call_json", lambda *args: {"suggestions": [{"name": ""}]})
    assert client.post(path, json=request).status_code == 502
    assert len(client.get("/api/items").json()) == 4


def test_ai_inflight_state_change(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from todo_backend.modules.work import decomposition

    ids = seed(client)

    def changed(*args: str) -> object:
        assert status(client, ids["event"], "completed") == 200
        return {"suggestions": []}

    monkeypatch.setattr(decomposition, "call_json", changed)
    response = client.post(
        f"/api/events/{ids['event']}/decomposition",
        json={"consent": True, "snapshot": body(client, ids)["snapshot"]},
    )
    assert response.status_code == 409


def test_receipt_failure_recover_and_matter_transfer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.work import event_structure
    from todo_backend.modules.work.service import WorkError

    ids = seed(client)
    request = body(client, ids)
    path = f"/api/events/{ids['event']}/children"
    original = event_structure.receipt

    def fail(*args: object) -> dict[str, object]:
        raise WorkError(503, "读回失败")

    monkeypatch.setattr(event_structure, "receipt", fail)
    assert client.post(path, json=request).status_code == 503
    monkeypatch.setattr(event_structure, "receipt", original)
    receipt = client.get("/api/event-operations/" + str(request["operation_id"]))
    child = receipt.json()["created"][0]
    assert client.post(path, json=request).json() == receipt.json()
    target = client.post(
        "/api/items",
        json={
            "type": "thing",
            "parent": ids["module"],
            "name": "接收事情",
            "operation_id": str(uuid4()),
        },
    ).json()
    preview = client.get(f"/api/items/{ids['thing']}/deletion").json()
    response = client.post(
        f"/api/items/{ids['thing']}/deletion",
        json={
            "operation_id": str(uuid4()),
            "snapshot": preview["snapshot"],
            "target_id": target["id"],
        },
    )
    assert response.status_code == 200, response.text
    structure = client.get(f"/api/events/{ids['event']}/structure").json()
    assert structure["branches"][0]["child_id"] == child
    events = [r for r in client.get("/api/items").json() if r["type"] == "event"]
    assert all(r["parent"] == target["id"] for r in events)
    assert status(client, ids["event"], "completed") == 409


def test_receipt_insert_failure_rolls_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy import Table, insert
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.sql.dml import Insert

    from todo_backend.modules.work import event_structure
    from todo_backend.modules.work.event_repository import receipts

    ids = seed(client)
    original = insert

    def fail(table: Table) -> Insert:
        if table is receipts:
            raise OperationalError("test", {}, Exception("injected"))
        return original(table)

    monkeypatch.setattr(event_structure, "insert", fail)
    response = client.post(f"/api/events/{ids['event']}/children", json=body(client, ids))
    assert response.status_code == 503
    assert len(client.get("/api/items").json()) == 4
    assert not client.get(f"/api/events/{ids['event']}/structure").json()["branches"]
