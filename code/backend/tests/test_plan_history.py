"""Date-change history is scoped, atomic, replayable, and independent of child work."""

from pathlib import Path
from typing import cast
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import insert
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError
from test_priorities import thing
from test_work import client as client_fixture
from test_work import payload

from todo_backend.database import build_engine
from todo_backend.main import create_app
from todo_backend.modules.work import plan_history, service
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput

client = client_fixture


def edited(row: dict[str, object], **extra: object) -> dict[str, object]:
    """Build a versioned edit from the last read result."""
    return {
        **{k: v for k, v in row.items() if k not in ("id", "version")},
        "operation_id": str(uuid4()),
        "expected_version": row["version"],
        **extra,
    }


@pytest.mark.parametrize("kind", ["thing", "event"])
def test_continuous_history_and_no_child_effect(client: TestClient, kind: str) -> None:
    matter = thing(client)
    child = client.post("/api/items", json=payload("event", str(matter["id"]))).json()
    row = matter if kind == "thing" else child
    url = "/api/items/" + str(row["id"])
    assert client.get(url + "/plan-history").json()["records"] == []
    first = client.put(url, json=edited(row, planEnd="2026-11-20"))
    assert first.status_code == 200, first.text
    row = first.json()
    assert client.put(url, json=edited(row, planEnd="2026-11-23")).status_code == 422
    body = edited(row, planEnd="2026-11-23", plan_change_reason="等待评审反馈")
    saved = client.put(url, json=body)
    assert saved.status_code == 200, saved.text
    assert client.put(url, json=body).json() == saved.json()
    assert client.put(url, json={**body, "plan_change_reason": "不同原因"}).status_code == 409
    assert (
        client.put(
            url, json=edited(row, planEnd="2026-11-24", plan_change_reason="冲突")
        ).status_code
        == 409
    )
    row = saved.json()
    assert client.put(url, json=edited(row, plan_change_reason="无变化")).json() == row
    cleared = client.put(
        url, json=edited(row, planEnd="", plan_change_reason="重新评估排期")
    ).json()
    assert client.put(url, json=edited(cleared, planEnd="2026-11-25")).status_code == 422
    view = client.get(url + "/plan-history").json()
    assert len(view["records"]) == 3
    assert view["baseline"]["end"] == "2026-11-20"
    assert view["baseline"]["incomplete"] is False
    assert client.get("/api/plan-history-counts").json()[row["id"]] == 3
    assert client.get("/api/operations/" + str(body["operation_id"])).status_code == 200
    if kind == "thing":
        assert next(x for x in client.get("/api/items").json() if x["id"] == child["id"]) == child


def test_closed_permissions_deleted_and_input_rejections(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    row = thing(client)
    url = "/api/items/" + str(row["id"])
    row = client.put(url, json=edited(row, planEnd="2026-11-20", status="completed")).json()
    assert (
        client.put(
            url, json=edited(row, planEnd="2026-11-25", status="working", plan_change_reason="延后")
        ).status_code
        == 409
    )
    row = client.put(url, json=edited(row, status="working")).json()
    for extra in (
        {"plan_change_reason": " "},
        {"plan_change_reason": "a" * 501},
        {"planStart": "2026-11-26", "plan_change_reason": "日期倒置"},
    ):
        assert client.put(url, json=edited(row, planEnd="2026-11-25", **extra)).status_code == 422
    assert len(client.get(url + "/plan-history").json()["records"]) == 1
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get(url + "/plan-history").status_code == 404
    assert client.get("/api/plan-history-counts").json() == {}

    assert (
        client.put(
            url, json=edited(row, planEnd="2026-11-25", plan_change_reason="越权")
        ).status_code
        == 404
    )
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    app = cast(FastAPI, client.app)
    with app.state.engine.begin() as conn:
        conn.execute(
            insert(deletions).values(
                id=str(uuid4()), account="personal", item_id=row["id"], fingerprint="", result="{}"
            )
        )
    assert client.get(url + "/plan-history").status_code == 404
    assert client.get("/api/plan-history-counts").json() == {}


def test_atomic_failure_and_uncertain_readback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    row = thing(client)
    url = "/api/items/" + str(row["id"])
    first = client.put(url, json=edited(row, planEnd="2026-11-20")).json()
    body = edited(first, planEnd="2026-11-24", plan_change_reason="等待意见")
    original = plan_history.record

    def fail_after_insert(
        conn: Connection, account: str, current: ItemOutput, data: WriteInput
    ) -> None:
        original(conn, account, current, data)
        raise SQLAlchemyError("simulated transaction failure")

    with monkeypatch.context() as patch:
        patch.setattr(plan_history, "record", fail_after_insert)
        assert client.put(url, json=body).status_code == 503
    view = client.get(url + "/plan-history").json()
    assert view["item"] == first
    assert len(view["records"]) == 1
    assert client.get("/api/operations/" + str(body["operation_id"])).status_code == 404
    original_read = read_item
    reads = 0

    def failed_read(conn: Connection, account: str, item_id: str) -> ItemOutput | None:
        nonlocal reads
        reads += 1
        if reads == 3:
            raise SQLAlchemyError("simulated readback failure")
        return original_read(conn, account, item_id)

    with monkeypatch.context() as patch:
        patch.setattr(service, "read_item", failed_read)
        assert client.put(url, json=body).status_code == 503
    assert (
        client.get("/api/operations/" + str(body["operation_id"])).json()["planEnd"] == "2026-11-24"
    )
    assert len(client.get(url + "/plan-history").json()["records"]) == 2


def test_legacy_migration_preserves_plan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database = database_for_test(tmp_path / "legacy.db")
    monkeypatch.setenv("TODO_DATABASE_URL", database)
    command.upgrade(Config("alembic.ini"), "0016")
    engine = build_engine(database)
    parent = None
    with engine.begin() as conn:
        for kind in ("goal", "module", "thing"):
            item_id = str(uuid4())
            conn.execute(
                insert(items).values(
                    id=item_id,
                    account="personal",
                    type=kind,
                    parent=parent,
                    name=kind,
                    description="",
                    owner="",
                    planStart="",
                    planEnd="2026-11-20" if kind == "thing" else "",
                    status="working" if kind == "thing" else "notStarted",
                    version=1,
                )
            )
            parent = item_id
    command.upgrade(Config("alembic.ini"), "head")
    engine.dispose()
    with TestClient(create_app(), base_url="http://127.0.0.1") as value:
        value.get("/api/session", headers={"X-Todo-Client": "web"})
        url = "/api/items/" + item_id
        view = value.get(url + "/plan-history").json()
        assert view["baseline"]["incomplete"] is True
        assert view["baseline"]["end"] == "2026-11-20"
        assert view["records"] == []
        assert view["item"]["version"] == 1
        assert value.put(url, json=edited(view["item"], planEnd="2026-11-25")).status_code == 422
