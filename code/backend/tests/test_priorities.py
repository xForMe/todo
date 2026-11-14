"""Behavioral coverage of weekly priority changes."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_work import client as client_fixture
from test_work import payload

client = client_fixture


def thing(client: TestClient) -> dict[str, object]:
    """Create an isolated hierarchy."""
    parent = None
    result = {}
    for kind in ("goal", "module", "thing"):
        result = client.post("/api/items", json=payload(kind, parent)).json()
        parent = result["id"]
    return result


def test_priority_cycle(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from todo_backend.modules.work import priority_repository, priority_service

    item = thing(client)
    state = client.get("/api/priorities").json()
    assert state["items"][0]["due"]
    body = dict(
        operation_id=str(uuid4()),
        expected_version=item["version"],
        week=state["week"],
        priority=2,
        review=False,
    )
    url = f"/api/items/{item['id']}/priority"
    saved = client.post(url, json=body)
    assert saved.status_code == 200
    assert client.get("/api/priorities").json()["items"][0]["due"]
    assert client.post(url, json=body).json() == saved.json()
    body.update(operation_id=str(uuid4()), expected_version=saved.json()["version"], review=True)
    reviewed = client.post(url, json=body)
    assert reviewed.status_code == 200
    assert not client.get("/api/priorities").json()["items"][0]["due"]
    assert client.get("/api/operations/" + body["operation_id"]).json() == reviewed.json()
    body["operation_id"] = str(uuid4())
    assert client.post(url, json=body).status_code == 409
    monkeypatch.setattr(priority_repository, "current_week", lambda: "2099-01-05")
    monkeypatch.setattr(priority_service, "current_week", lambda: "2099-01-05")
    assert client.get("/api/priorities").json()["items"][0]["due"]
    body["expected_version"] = reviewed.json()["version"]
    assert client.post(url, json=body).status_code == 409


def test_priority_reject_and_reopen(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    item = thing(client)
    body = dict(
        operation_id=str(uuid4()),
        expected_version=item["version"],
        week=client.get("/api/priorities").json()["week"],
        priority=0,
        review=True,
    )
    url = f"/api/items/{item['id']}/priority"
    assert client.post(url, json=body).status_code == 422
    body["priority"] = 1
    saved = client.post(url, json=body).json()
    for status in ("completed", "working"):
        edit = {k: v for k, v in saved.items() if k not in ("id", "version")}
        edit.update(operation_id=str(uuid4()), expected_version=saved["version"], status=status)
        response = client.put("/api/items/" + str(item["id"]), json=edit)
        assert response.status_code == 200
        saved = response.json()
        if status == "completed":
            assert not client.get("/api/priorities").json()["items"][0]["due"]
            body.update(operation_id=str(uuid4()), expected_version=saved["version"])
            assert client.post(url, json=body).status_code == 409
    assert client.get("/api/priorities").json()["items"][0]["due"]
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get("/api/priorities").json()["items"] == []
    assert client.post(url, json=body).status_code == 404


def test_priority_rollback(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from sqlalchemy import Table, insert
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.sql.dml import Insert

    from todo_backend.modules.work import priority_service
    from todo_backend.modules.work.repository import operations

    item = thing(client)
    body = dict(
        operation_id=str(uuid4()),
        expected_version=item["version"],
        week=client.get("/api/priorities").json()["week"],
        priority=2,
        review=True,
    )
    original = insert

    def fail(table: Table) -> Insert:
        if table is operations:
            raise OperationalError("test", {}, Exception("injected"))
        return original(table)

    monkeypatch.setattr(priority_service, "insert", fail)
    assert client.post(f"/api/items/{item['id']}/priority", json=body).status_code == 503
    state = client.get("/api/priorities").json()["items"][0]
    assert state["priority"] == 0 and state["due"]
    assert state["version"] == item["version"]
    monkeypatch.setattr(priority_service, "insert", original)
    assert client.post(f"/api/items/{item['id']}/priority", json=body).status_code == 200
