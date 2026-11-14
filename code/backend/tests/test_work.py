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
    url = database_for_test(tmp_path / "test.db")
    monkeypatch.setenv("TODO_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as value:
        assert value.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        yield value


def payload(kind: str, parent: str | None = None) -> dict[str, object]:
    return {"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": "记录"}


def test_complete_loop_and_replay(client: TestClient) -> None:
    parent = None
    objects = []
    for kind in ("goal", "module", "thing", "event"):
        body = payload(kind, parent)
        response = client.post("/api/items", json=body)
        assert response.status_code == 200, response.text
        saved = response.json()
        assert client.post("/api/items", json=body).json() == saved
        body["name"] = "不同内容"
        assert client.post("/api/items", json=body).status_code == 409
        parent = saved["id"]
        objects.append(saved)
    event = objects[-1]
    edit = {
        **event,
        "operation_id": str(uuid4()),
        "expected_version": event["version"],
        "status": "completed",
        "owner": "测试人员",
        "planStart": "2026-11-12",
        "planEnd": "2026-11-13",
    }
    edit.pop("id")
    edit.pop("version")
    updated = client.put("/api/items/" + event["id"], json=edit)
    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"
    assert client.get("/api/operations/" + str(edit["operation_id"])).json() == updated.json()
    edit["operation_id"] = str(uuid4())
    assert client.put("/api/items/" + event["id"], json=edit).status_code == 409
    edit["expected_version"] = updated.json()["version"]
    same = client.put("/api/items/" + event["id"], json=edit).json()
    assert same["version"] == updated.json()["version"]
    edit["operation_id"] = str(uuid4())
    edit["status"] = "notStarted"
    assert client.put("/api/items/" + event["id"], json=edit).json()["status"] == "notStarted"
    all_items = client.get("/api/items").json()
    assert len(all_items) == 4
    assert next(x for x in all_items if x["id"] == objects[-2]["id"])["status"] == "notStarted"
    with TestClient(create_app(), base_url="http://127.0.0.1") as reopened:
        reopened.get("/api/session", headers={"X-Todo-Client": "web"})
        assert len(reopened.get("/api/items").json()) == 4


def test_rejections(client: TestClient) -> None:
    assert client.get("/api/items", headers={"Origin": "https://example.com"}).status_code == 403
    assert client.post("/api/items", json={**payload("goal"), "name": " "}).status_code == 422
    assert client.post("/api/items", json=payload("event", "missing")).status_code == 404
    goal = client.post("/api/items", json=payload("goal")).json()
    assert client.post("/api/items", json=payload("event", goal["id"])).status_code == 404
    for extra in (
        {"planStart": "bad"},
        {"planStart": "2026-11-13", "planEnd": "2026-11-12"},
    ):
        assert client.post("/api/items", json={**payload("thing"), **extra}).status_code == 422
    assert len(client.get("/api/items").json()) == 1


def test_foreign_owner(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    goal = client.post("/api/items", json=payload("goal")).json()
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get("/api/items").json() == []
    assert client.post("/api/items", json=payload("module", goal["id"])).status_code == 404


def test_write_failure_rolls_back(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from sqlalchemy import Table, insert
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.sql.dml import Insert

    from todo_backend.modules.work import service
    from todo_backend.modules.work.repository import operations

    original = insert

    def fail_operations(table: Table) -> Insert:
        if table is operations:
            raise OperationalError("test", {}, Exception("injected"))
        return original(table)

    monkeypatch.setattr(service, "insert", fail_operations)
    assert client.post("/api/items", json=payload("goal")).status_code == 503
    assert client.get("/api/items").json() == []


def test_readback_uncertain_can_be_resolved(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy.exc import OperationalError

    from todo_backend.modules.work import service
    from todo_backend.modules.work.repository import read_item

    original = read_item

    def fail_read(*args: object) -> None:
        raise OperationalError("test", {}, Exception("injected"))

    body = payload("goal")
    monkeypatch.setattr(service, "read_item", fail_read)
    assert client.post("/api/items", json=body).status_code == 503
    monkeypatch.setattr(service, "read_item", original)
    assert client.get("/api/operations/" + str(body["operation_id"])).status_code == 200
    assert len(client.get("/api/items").json()) == 1


def test_automatic_session_boundary(client: TestClient) -> None:
    assert (
        client.get(
            "/api/session", headers={"X-Todo-Client": "web", "Origin": "https://example.com"}
        ).status_code
        == 403
    )
    assert client.get("/api/session").status_code == 403
    assert client.get("/api/items", headers={"Host": "evil.example"}).status_code == 400
    client.cookies.clear()
    assert client.get("/api/items").status_code == 401
    response = client.get("/api/session", headers={"X-Todo-Client": "web"})
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert client.get("/api/items").status_code == 200


def test_date_only_and_legacy_read() -> None:
    from pydantic import ValidationError

    from todo_backend.modules.work.schemas import ItemInput, ItemOutput

    assert (
        ItemInput(type="thing", name="日期", planStart="2026-11-13", planEnd="2026-11-13").planEnd
        == "2026-11-13"
    )
    for value in ("2026-11-13T09:00", "2026-02-30", "20261113", "2026-1-3"):
        with pytest.raises(ValidationError):
            ItemInput(type="event", name="日期", planStart=value)
    old = ItemOutput(
        type="event",
        name="旧记录",
        id="old",
        version=1,
        planStart="2026-11-13T09:00",
        planEnd="2026-11-13T18:00",
    )
    assert old.planStart == old.planEnd == "2026-11-13"
