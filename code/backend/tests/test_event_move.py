"""Regression coverage for issue #1 using isolated, offline databases."""

import json
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Table, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql.dml import Insert
from test_event_structure import body, seed, status
from test_event_structure import client as client

from todo_backend.modules.sources.follow import attempts, rules
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work import event_move
from todo_backend.modules.work.event_repository import receipts
from todo_backend.modules.work.repository import items
from todo_backend.modules.work.service import WorkError


def engine(client: TestClient) -> Engine:
    """Use only the application engine backed by the isolated fixture."""
    assert isinstance(client.app, FastAPI)
    value = client.app.state.engine
    assert isinstance(value, Engine)
    return value


def request(client: TestClient, event_id: str, target_id: str) -> dict[str, str]:
    """Build a confirmed request from the actual preview endpoint."""
    view = client.get(f"/api/events/{event_id}/move", params={"target_id": target_id})
    assert view.status_code == 200, view.text
    return {
        "operation_id": str(uuid4()),
        "target_id": target_id,
        "snapshot": view.json()["snapshot"],
    }


def test_move_tree_fields_links_and_replay(client: TestClient) -> None:
    src, dest = seed(client), seed(client)
    path = f"/api/events/{src['event']}"
    child = client.post(path + "/children", json=body(client, src)).json()["created"][0]
    grandchild = client.post(
        f"/api/events/{child}/children", json=body(client, {**src, "event": child})
    ).json()["created"][0]
    assert status(client, grandchild, "completed") == 200
    structure = client.get(path + "/structure").json()
    assert (
        client.post(
            path + "/children",
            json={
                "action": "link",
                "target": grandchild,
                "snapshot": structure["snapshot"],
                "operation_id": str(uuid4()),
            },
        ).status_code
        == 200
    )
    before = {r["id"]: r for r in client.get("/api/items").json()}
    payload = request(client, src["event"], dest["thing"])
    result = client.post(path + "/move", json=payload)
    assert result.status_code == 200, result.text
    assert set(result.json()["moved_ids"]) == {src["event"], child, grandchild}
    after = {r["id"]: r for r in client.get("/api/items").json()}
    for key, row in before.items():
        expected = (
            {**row, "parent": dest["thing"], "version": row["version"] + 1}
            if key in result.json()["moved_ids"]
            else row
        )
        assert after[key] == expected
    view = client.get(path + "/structure").json()
    assert len(view["branches"]) == 2 and len(view["links"]) == 1
    assert status(client, src["event"], "completed") == 409
    assert client.post(path + "/move", json=payload).json() == result.json()
    assert client.get("/api/event-operations/" + payload["operation_id"]).json() == result.json()
    assert (
        client.post(path + "/move", json={**payload, "target_id": src["thing"]}).status_code == 409
    )
    assert {r["id"]: r for r in client.get("/api/items").json()} == after


def test_child_detaches_and_external_links_block(client: TestClient) -> None:
    src, dest = seed(client), seed(client)
    root = f"/api/events/{src['event']}"
    child = client.post(root + "/children", json=body(client, src)).json()["created"][0]
    view = client.get(root + "/structure").json()
    client.post(
        root + "/children",
        json={
            "action": "link",
            "target": child,
            "snapshot": view["snapshot"],
            "operation_id": str(uuid4()),
        },
    )
    path = f"/api/events/{child}"
    assert client.get(path + "/move", params={"target_id": dest["thing"]}).status_code == 409
    view = client.get(root + "/structure").json()
    assert (
        client.post(
            root + "/children",
            json={
                "action": "unlink",
                "target": view["links"][0]["id"],
                "snapshot": view["snapshot"],
                "operation_id": str(uuid4()),
            },
        ).status_code
        == 200
    )
    preview = client.get(path + "/move", params={"target_id": dest["thing"]}).json()
    assert preview["detached_parent"] == src["event"]
    assert (
        client.post(path + "/move", json=request(client, child, dest["thing"])).status_code == 200
    )
    assert not client.get(path + "/structure").json()["branches"]
    assert status(client, src["event"], "completed") == 200
    assert status(client, child, "working") == 200


def test_invalid_destination_ownership_and_stale_snapshot(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, dest = seed(client), seed(client)
    path = f"/api/events/{src['event']}/move"
    for target in (str(uuid4()), dest["module"], dest["event"], src["thing"]):
        assert client.get(path, params={"target_id": target}).status_code in (404, 422)
    payload = request(client, src["event"], dest["thing"])
    assert status(client, dest["thing"], "completed") == 200
    assert client.post(path, json=payload).status_code == 409
    assert status(client, dest["thing"], "working") == 200
    assert client.post(path, json=payload).status_code == 409
    payload = request(client, src["event"], dest["thing"])
    assert status(client, src["event"], "working") == 200
    assert client.post(path, json=payload).status_code == 409
    # Mark the receiver unavailable; a forged direct write must not bypass preview.
    with engine(client).begin() as conn:
        conn.execute(update(items).where(items.c.id == dest["thing"]).values(account="other"))
    assert client.post(path, json=payload).status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get(path, params={"target_id": dest["thing"]}).status_code == 404


def test_deleted_target_and_same_module_move(client: TestClient) -> None:
    src = seed(client)
    target = client.post(
        "/api/items",
        json={
            "type": "thing",
            "parent": src["module"],
            "name": "合同回款",
            "operation_id": str(uuid4()),
        },
    ).json()["id"]
    path = f"/api/events/{src['event']}/move"
    payload = request(client, src["event"], target)
    assert client.post(path, json=payload).status_code == 200
    # Empty source can now be deleted and must never be accepted as a destination.
    preview = client.get(f"/api/items/{src['thing']}/deletion").json()
    assert (
        client.post(
            f"/api/items/{src['thing']}/deletion",
            json={
                "operation_id": str(uuid4()),
                "snapshot": preview["snapshot"],
            },
        ).status_code
        == 200
    )
    assert client.get(path, params={"target_id": src["thing"]}).status_code == 404


def context_records(client: TestClient, src: dict[str, str]) -> tuple[str, str, str]:
    """Seed already-stored provenance without reaching external adapters."""
    doc, proposal, progress = (str(uuid4()) for _ in range(3))
    with engine(client).begin() as conn:
        account = conn.execute(
            select(items.c.account).where(items.c.id == src["event"])
        ).scalar_one()
        conn.execute(
            insert(sources).values(
                id=doc,
                account=account,
                context=src["event"],
                kind="doc",
                address="fixture",
                interval=60,
                enabled=True,
                removed=False,
                version=1,
                next_run=0,
                last_run=0,
                content="evidence",
                ai_consent=True,
                ai_hash="",
                status="ready",
            )
        )
        for key, state, action in (
            (proposal, "pending", "update"),
            (progress, "linked", "progress"),
        ):
            conn.execute(
                insert(suggestions).values(
                    id=key,
                    account=account,
                    source_id=doc,
                    thing_id=src["thing"],
                    event_id=src["event"],
                    event_version=1,
                    action=action,
                    state=state,
                    body=json.dumps({"thing_id": src["thing"], "evidence": "evidence"}),
                )
            )
        conn.execute(
            insert(rules).values(
                event_id=src["event"],
                account=account,
                recipient="fixture",
                content="fixture",
                at="09:00",
                cap=3,
                count=1,
                enabled=True,
                event_version=1,
                version=1,
                next_run=0,
                status="ready",
            )
        )
        conn.execute(
            insert(attempts).values(
                id=str(uuid4()),
                account=account,
                event_id=src["event"],
                created=0,
                content="fixture",
                state="sent",
                message_id="old-message",
            )
        )
    return doc, proposal, progress


def test_provenance_pause_pending_invalidation_and_inflight_guards(client: TestClient) -> None:
    src, dest = seed(client), seed(client)
    doc, proposal, progress = context_records(client, src)
    path = f"/api/events/{src['event']}/move"
    payload = request(client, src["event"], dest["thing"])
    with engine(client).begin() as conn:
        conn.execute(
            update(suggestions).where(suggestions.c.id == proposal).values(state="applying")
        )
    assert client.post(path, json=payload).status_code == 409
    with engine(client).begin() as conn:
        conn.execute(
            update(suggestions).where(suggestions.c.id == proposal).values(state="pending")
        )
        conn.execute(update(attempts).values(state="pending"))
    assert client.post(path, json=payload).status_code == 409
    with engine(client).begin() as conn:
        conn.execute(update(attempts).values(state="sent"))
    assert client.post(path, json=payload).status_code == 200
    with engine(client).connect() as conn:
        source = conn.execute(select(sources).where(sources.c.id == doc)).mappings().one()
        assert (
            source["context"] == src["event"] and not source["enabled"] and source["version"] == 2
        )
        pending_row = (
            conn.execute(select(suggestions).where(suggestions.c.id == proposal)).mappings().one()
        )
        assert pending_row["state"] == "rejected" and pending_row["thing_id"] == dest["thing"]
        assert json.loads(pending_row["body"])["thing_id"] == src["thing"]
        linked = (
            conn.execute(select(suggestions).where(suggestions.c.id == progress)).mappings().one()
        )
        assert (
            linked["state"] == "linked" and json.loads(linked["body"])["thing_id"] == dest["thing"]
        )
        rule = conn.execute(select(rules)).mappings().one()
        assert not rule["enabled"] and rule["count"] == 1 and rule["version"] == 2
        assert conn.execute(select(attempts.c.message_id)).scalar_one() == "old-message"


def test_transaction_rollback_and_committed_read_recovery(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, dest = seed(client), seed(client)
    context_records(client, src)
    path = f"/api/events/{src['event']}/move"
    payload = request(client, src["event"], dest["thing"])
    before = client.get("/api/items").json()

    def fail(table: Table) -> Insert:
        if table is receipts:
            raise OperationalError("test", {}, Exception("injected"))
        return insert(table)

    with monkeypatch.context() as patch:
        patch.setattr(event_move, "insert", fail)
        assert client.post(path, json=payload).status_code == 503
    assert client.get("/api/items").json() == before
    with engine(client).connect() as conn:
        assert conn.execute(select(sources.c.enabled)).scalar_one()
        assert conn.execute(select(rules.c.enabled)).scalar_one()
    assert client.get("/api/event-operations/" + payload["operation_id"]).status_code == 404

    def fail_read(*args: object) -> dict[str, object]:
        raise WorkError(503, "injected read failure")

    with monkeypatch.context() as patch:
        patch.setattr(event_move, "receipt", fail_read)
        assert client.post(path, json=payload).status_code == 503
    result = client.get("/api/event-operations/" + payload["operation_id"])
    assert result.status_code == 200
    assert client.post(path, json=payload).json() == result.json()
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get("/api/event-operations/" + payload["operation_id"]).status_code == 404


def test_new_child_after_preview_rejects_stale_move(client: TestClient) -> None:
    src, dest = seed(client), seed(client)
    path = f"/api/events/{src['event']}"
    payload = request(client, src["event"], dest["thing"])
    assert client.post(path + "/children", json=body(client, src)).status_code == 200
    assert client.post(path + "/move", json=payload).status_code == 409
    assert all(
        e["parent"] == src["thing"] for e in client.get(path + "/structure").json()["events"]
    )


def test_review_snapshot_binds_event_and_destination(client: TestClient) -> None:
    src, dest, other = seed(client), seed(client), seed(client)
    payload = request(client, src["event"], dest["thing"])
    assert (
        client.post(
            f"/api/events/{src['event']}/move", json={**payload, "target_id": other["thing"]}
        ).status_code
        == 409
    )
    assert client.post(f"/api/events/{other['event']}/move", json=payload).status_code == 409
