"""Planning safety and atomic confirmation across the authenticated API."""

from collections.abc import Iterator
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
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.client import AIError
from todo_backend.main import create_app
from todo_backend.modules.matter_decomposition import generation, service
from todo_backend.modules.work.repository import items


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "planning.db"))
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as value:
        value.get("/api/session", headers={"X-Todo-Client": "web"})
        yield value


def seed(client: TestClient) -> str:
    parent = None
    for kind in ("goal", "module", "thing"):
        result = client.post(
            "/api/items",
            json={
                "operation_id": str(uuid4()),
                "type": kind,
                "parent": parent,
                "name": kind,
            },
        )
        assert result.status_code == 200
        parent = result.json()["id"]
    return str(parent)


def test_type_scoping_replay_and_conflicts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert len(client.get("/api/decomposition/types").json()) == 5
    data = {
        "operation_id": str(uuid4()),
        "expected_version": 0,
        "name": "功能交付",
        "prompt": "先评审原型再验证",
        "enabled": True,
    }
    path = "/api/decomposition/types/feature"
    result = client.put(path, json=data)
    assert result.status_code == 200
    assert result.json()["type"]["version"] == 1
    assert client.put(path, json=data).json() == result.json()
    assert client.put(path, json={**data, "prompt": "changed"}).status_code == 409
    assert client.put(path, json={**data, "operation_id": str(uuid4())}).status_code == 409
    assert (
        client.put(
            "/api/decomposition/types/custom",
            json={
                **data,
                "operation_id": str(uuid4()),
            },
        ).status_code
        == 409
    )
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get("/api/decomposition/types").json()[0]["version"] == 0


def test_generate_uses_classified_prompt_without_creating_events(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matter = seed(client)
    path = f"/api/matters/{matter}/decomposition"
    snapshot = client.get(path).json()["snapshot"]
    calls: list[str] = []

    def fake(instructions: str, content: str, context: str) -> object:
        calls.append(content)
        if len(calls) == 1:
            return {"type_id": "issue"}
        assert "现象与证据" in content
        return {"suggestions": [{"name": "核对异常", "description": "收集证据", "reason": "定位"}]}

    monkeypatch.setattr(generation, "call_json", fake)
    result = client.post(path, json={"snapshot": snapshot})
    assert result.status_code == 200, result.text
    assert len(calls) == 2
    assert result.json()["basis"]["type_id"] == "issue"
    assert len(client.get("/api/items").json()) == 3
    body = {
        "operation_id": str(uuid4()),
        "snapshot": snapshot,
        "generation_id": result.json()["generation_id"],
        "events": [
            {
                "type": "event",
                "parent": matter,
                "name": "核对异常",
                "owner": "用户指定",
                "planStart": "2026-11-17",
                "planEnd": "2026-11-18",
            }
        ],
    }
    created = client.post(path + "/confirm", json=body)
    assert created.status_code == 200, created.text
    assert created.json()["created"][0]["parent"] == matter
    assert created.json()["created"][0]["owner"] == "用户指定"
    assert client.post(path + "/confirm", json=body).json() == created.json()
    assert len(client.get("/api/items").json()) == 4
    assert client.get("/api/event-operations/" + str(body["operation_id"])).json() == created.json()


def test_manual_type_failure_and_late_response(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matter = seed(client)
    path = f"/api/matters/{matter}/decomposition"
    body = {"snapshot": client.get(path).json()["snapshot"], "type_id": "research"}

    def failed(instructions: str, content: str, context: str) -> object:
        assert "比较方案" in content
        raise AIError("offline")

    monkeypatch.setattr(generation, "call_json", failed)
    assert client.post(path, json=body).status_code == 502

    def late(instructions: str, content: str, context: str) -> object:
        response = client.put(
            "/api/decomposition/types/research",
            json={
                "operation_id": str(uuid4()),
                "expected_version": 0,
                "name": "调研分析",
                "prompt": "变更后的提示词",
                "enabled": False,
            },
        )
        assert response.status_code == 200
        return {"suggestions": []}

    monkeypatch.setattr(generation, "call_json", late)
    assert client.post(path, json=body).status_code == 409
    assert len(client.get("/api/items").json()) == 3


def test_confirm_atomic_rejection_and_account_scope(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matter = seed(client)
    path = f"/api/matters/{matter}/decomposition"
    body = {
        "operation_id": str(uuid4()),
        "snapshot": client.get(path).json()["snapshot"],
        "events": [
            {"type": "event", "parent": matter, "name": "first"},
            {"type": "event", "parent": "other", "name": "second"},
        ],
    }
    assert client.post(path + "/confirm", json=body).status_code == 422
    assert len(client.get("/api/items").json()) == 3
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get(path).status_code == 404
    assert client.post(path + "/confirm", json=body).status_code == 404


def test_committed_write_can_be_recovered_after_readback_failure(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matter = seed(client)
    path = f"/api/matters/{matter}/decomposition"
    body = {
        "operation_id": str(uuid4()),
        "snapshot": client.get(path).json()["snapshot"],
        "events": [{"type": "event", "parent": matter, "name": "已提交行动"}],
    }

    def unreadable(*args: object) -> dict[str, object]:
        raise SQLAlchemyError("offline readback")

    with monkeypatch.context() as patch:
        patch.setattr(service, "receipt", unreadable)
        assert client.post(path + "/confirm", json=body).status_code == 503
    receipt = client.get("/api/event-operations/" + str(body["operation_id"]))
    assert receipt.status_code == 200
    assert client.post(path + "/confirm", json=body).json() == receipt.json()
    assert len(client.get("/api/items").json()) == 4


@pytest.mark.parametrize("status", ["completed", "cancelled"])
def test_closed_matter_rejects_planning(client: TestClient, status: str) -> None:
    matter = seed(client)
    row = next(r for r in client.get("/api/items").json() if r["id"] == matter)
    row.pop("id")
    row["expected_version"] = row.pop("version")
    row.update(status=status, operation_id=str(uuid4()))
    assert client.put("/api/items/" + matter, json=row).status_code == 200
    assert client.get(f"/api/matters/{matter}/decomposition").status_code == 409


def test_migration_preserves_existing_work(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "upgrade.db"))
    command.upgrade(Config("alembic.ini"), "0014")
    with TestClient(create_app(), base_url="http://127.0.0.1") as client:
        client.get("/api/session", headers={"X-Todo-Client": "web"})
        app = cast(FastAPI, client.app)
        with app.state.engine.begin() as conn:
            parent = None
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
                        planEnd="",
                        status="notStarted",
                        version=1,
                    )
                )
                parent = item_id
        before = client.get("/api/items").json()
        command.upgrade(Config("alembic.ini"), "0015")
        assert client.get("/api/items").json() == before
        assert len(client.get("/api/decomposition/types").json()) == 5
