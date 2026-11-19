"""Daily review isolation, time boundaries and recoverable transactional writes."""

from datetime import datetime
from typing import cast
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Table, insert, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql.dml import Insert
from test_priorities import thing
from test_work import client as client_fixture
from test_work import payload

from todo_backend.modules.work import daily_review as service
from todo_backend.modules.work.repository import deletions

client = client_fixture


def action(client: TestClient) -> dict[str, object]:
    """Create a fresh isolated event in a complete hierarchy."""
    return cast(
        dict[str, object],
        client.post("/api/items", json=payload("event", str(thing(client)["id"]))).json(),
    )


def body(client: TestClient, revision: int = 0, reviewed: bool = True) -> dict[str, object]:
    """Use the same date as the displayed snapshot."""
    return dict(
        operation_id=str(uuid4()),
        expected_version=1,
        expected_revision=revision,
        day=client.get("/api/workbench").json()["today"],
        reviewed=reviewed,
    )


def test_mark_undo_replay_without_business_changes(client: TestClient) -> None:
    item = action(client)
    before = client.get("/api/workbench").json()
    url = f"/api/items/{item['id']}/daily-review"
    data = body(client)
    saved = client.post(url, json=data)
    assert saved.status_code == 200, saved.text
    assert client.post(url, json=data).json() == saved.json()
    snap = client.get("/api/workbench").json()
    assert snap["items"] == before["items"]
    assert snap["priorities"] == before["priorities"]
    assert snap["daily_reviews"] == [saved.json()]
    repeat = client.post(url, json=body(client, 1)).json()
    assert repeat["reviewed_at"] == saved.json()["reviewed_at"]
    assert repeat["revision"] == 2
    undo = client.post(url, json=body(client, 2, False))
    assert undo.status_code == 200 and undo.json()["reviewed_at"] == ""
    assert client.post(url, json=body(client, 3)).json()["revision"] == 4
    assert client.post(url, json={**data, "reviewed": False}).status_code == 409
    assert client.post(url, json=body(client)).status_code == 409
    receipt = client.get("/api/daily-review-operations/" + str(data["operation_id"]))
    assert receipt.json() == saved.json()


def test_scope_state_versions_and_deletion(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = action(client)
    url = f"/api/items/{item['id']}/daily-review"
    data = body(client)
    assert client.post(url, json={**data, "expected_version": 99}).status_code == 409
    assert client.post(f"/api/items/{item['parent']}/daily-review", json=data).status_code == 404
    assert client.post(url, json={**data, "expected_revision": -1}).status_code == 422
    assert client.post(url, json=data, headers={"Origin": "https://example.com"}).status_code == 403
    saved = client.post(url, json=data)
    assert saved.status_code == 200
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.post(url, json=data).status_code == 404
    assert client.get("/api/workbench").json()["daily_reviews"] == []
    assert (
        client.get("/api/daily-review-operations/" + str(data["operation_id"])).status_code == 404
    )
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    edit = {k: v for k, v in item.items() if k not in ("id", "version")}
    edit.update(operation_id=str(uuid4()), expected_version=1, status="completed")
    assert client.put(f"/api/items/{item['id']}", json=edit).status_code == 200
    assert client.post(url, json=body(client, 1, False)).status_code == 409
    edit.update(operation_id=str(uuid4()), expected_version=2, status="working")
    assert client.put(f"/api/items/{item['id']}", json=edit).status_code == 200
    assert client.get("/api/workbench").json()["daily_reviews"] == [saved.json()]
    with cast(FastAPI, client.app).state.engine.begin() as conn:
        conn.execute(
            insert(deletions).values(
                id=str(uuid4()),
                account="personal",
                item_id=item["id"],
                fingerprint="fixture",
                result="{}",
            )
        )
    assert client.get("/api/workbench").json()["daily_reviews"] == []
    assert client.post(url, json=data).status_code == 404


def test_midnight_history_and_stale_page(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        service, "beijing_now", lambda: datetime.fromisoformat("2026-11-18T23:59:59+08:00")
    )
    # Snapshot and mutation share one clock contract.
    monkeypatch.setattr("todo_backend.modules.work.workbench.beijing_now", service.beijing_now)
    item = action(client)
    url = f"/api/items/{item['id']}/daily-review"
    data = body(client)
    first = client.post(url, json=data).json()
    monkeypatch.setattr(
        service, "beijing_now", lambda: datetime.fromisoformat("2026-11-19T00:00:01+08:00")
    )
    monkeypatch.setattr("todo_backend.modules.work.workbench.beijing_now", service.beijing_now)
    assert client.get("/api/workbench").json()["daily_reviews"] == []
    assert client.post(url, json={**data, "operation_id": str(uuid4())}).status_code == 409
    assert client.post(url, json=data).json() == first
    assert client.post(url, json=body(client)).status_code == 200
    with cast(FastAPI, client.app).state.engine.connect() as conn:
        assert len(conn.execute(select(service.reviews)).all()) == 2


def test_rollback_and_uncertain_readback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = action(client)
    url = f"/api/items/{item['id']}/daily-review"
    data = body(client)

    def fail(table: Table) -> Insert:
        if table is service.receipts:
            raise OperationalError("test", {}, Exception("injected"))
        return insert(table)

    monkeypatch.setattr(service, "insert", fail)
    assert client.post(url, json=data).status_code == 503
    assert client.get("/api/workbench").json()["daily_reviews"] == []
    monkeypatch.setattr(service, "insert", insert)
    original = service.receipt

    def lost(*args: object) -> service.ReviewOutput:
        raise OperationalError("test", {}, Exception("lost readback"))

    monkeypatch.setattr(service, "receipt", lost)
    assert client.post(url, json=data).status_code == 503
    monkeypatch.setattr(service, "receipt", original)
    assert (
        client.get("/api/daily-review-operations/" + str(data["operation_id"])).status_code == 200
    )
    assert client.post(url, json=data).json()["revision"] == 1
