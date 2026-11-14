"""Attention isolation, transactional receipts and scoped workbench snapshots."""

from typing import cast
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Table, insert
from sqlalchemy.engine import Connection
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql.dml import Insert
from test_priorities import thing
from test_work import client as client_fixture
from test_work import payload

from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.schemas import ItemOutput

client = client_fixture


def test_attention_replay_conflict_and_scope(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = thing(client)
    url = f"/api/items/{item['id']}/attention"
    before = client.get("/api/priorities").json()["items"][0]
    body = dict(operation_id=str(uuid4()), expected_version=1, enabled=True)
    saved = client.post(url, json=body)
    assert saved.status_code == 200
    assert client.post(url, json=body).json() == saved.json()
    assert client.get("/api/operations/" + str(body["operation_id"])).json() == saved.json()
    snap = client.get("/api/workbench").json()
    assert snap["attention"] == [{"item_id": item["id"], "enabled": True}]
    after = snap["priorities"]["items"][0]
    assert (before["priority"], before["due"]) == (after["priority"], after["due"])
    assert client.post(url, json={**body, "enabled": False}).status_code == 409
    assert client.post(url, json={**body, "operation_id": str(uuid4())}).status_code == 409
    goal = next(x for x in snap["items"] if x["type"] == "goal")
    assert client.post(f"/api/items/{goal['id']}/attention", json=body).status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "another")
    assert client.post(url, json=body).status_code == 404
    other = client.get("/api/workbench").json()
    assert all(other[key] == [] for key in ("items", "attention", "branches", "links"))
    assert (
        client.get("/api/workbench", headers={"Origin": "https://example.com"}).status_code == 403
    )


def test_attention_lifecycle_and_deletion(client: TestClient) -> None:
    from todo_backend.modules.work.repository import deletions

    item = thing(client)
    url = f"/api/items/{item['id']}/attention"
    saved = client.post(
        url, json=dict(operation_id=str(uuid4()), expected_version=1, enabled=True)
    ).json()
    for status in ("completed", "working", "cancelled"):
        edit = {k: v for k, v in saved.items() if k not in ("id", "version")}
        edit.update(operation_id=str(uuid4()), expected_version=saved["version"], status=status)
        response = client.put(f"/api/items/{item['id']}", json=edit)
        assert response.status_code == 200
        saved = response.json()
        assert client.get("/api/workbench").json()["attention"][0]["enabled"]
    response = client.post(
        url, json=dict(operation_id=str(uuid4()), expected_version=saved["version"], enabled=False)
    )
    assert response.status_code == 200
    assert not client.get("/api/workbench").json()["attention"][0]["enabled"]
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
    assert client.get("/api/workbench").json()["attention"] == []
    assert (
        client.post(
            url,
            json=dict(
                operation_id=str(uuid4()), expected_version=response.json()["version"], enabled=True
            ),
        ).status_code
        == 404
    )


def test_attention_rollback_and_uncertain_readback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.work import attention as service
    from todo_backend.modules.work.repository import operations

    item = thing(client)
    url = f"/api/items/{item['id']}/attention"
    body = dict(operation_id=str(uuid4()), expected_version=1, enabled=True)

    def fail(table: Table) -> Insert:
        if table is operations:
            raise OperationalError("test", {}, Exception("injected"))
        return insert(table)

    monkeypatch.setattr(service, "insert", fail)
    assert client.post(url, json=body).status_code == 503
    assert client.get("/api/workbench").json()["attention"] == []
    monkeypatch.setattr(service, "insert", insert)
    original = read_item
    calls = 0

    def fail_read(conn: Connection, account: str, item_id: str) -> ItemOutput | None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OperationalError("test", {}, Exception("lost response"))
        return original(conn, account, item_id)

    monkeypatch.setattr(service, "read_item", fail_read)
    assert client.post(url, json=body).status_code == 503
    assert client.get("/api/operations/" + str(body["operation_id"])).json()["version"] == 2
    monkeypatch.setattr(service, "read_item", original)
    assert client.post(url, json=body).json()["version"] == 2


def test_snapshot_tree_and_followup_direction(client: TestClient) -> None:
    from todo_backend.modules.work.event_repository import branches, links

    item = thing(client)
    first = client.post("/api/items", json=payload("event", str(item["id"]))).json()
    second = client.post("/api/items", json=payload("event", str(item["id"]))).json()
    with cast(FastAPI, client.app).state.engine.begin() as conn:
        conn.execute(
            insert(branches).values(
                child_id=second["id"], parent_id=first["id"], account="personal"
            )
        )
        conn.execute(
            insert(links).values(
                id=str(uuid4()),
                source=first["id"],
                target=second["id"],
                kind="followup",
                account="personal",
            )
        )
    snap = client.get("/api/workbench").json()
    assert snap["branches"] == [{"child_id": second["id"], "parent_id": first["id"]}]
    assert snap["links"][0]["source"] == first["id"]
    assert all("account" not in x for x in snap["items"])
    assert len(snap["today"]) == 10


def test_attention_preserved_after_module_transfer(client: TestClient) -> None:
    from test_deletion import branch, intent

    left, right = branch(client), branch(client)
    saved = client.post(
        f"/api/items/{left[2]}/attention",
        json=dict(operation_id=str(uuid4()), expected_version=1, enabled=True),
    )
    assert saved.status_code == 200
    result = client.post(f"/api/items/{left[1]}/deletion", json=intent(client, left[1], right[1]))
    assert result.status_code == 200
    snap = client.get("/api/workbench").json()
    moved = next(x for x in snap["items"] if x["id"] == left[2])
    assert moved["parent"] == right[1]
    assert snap["attention"] == [{"item_id": left[2], "enabled": True}]
