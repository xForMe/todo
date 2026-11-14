"""Explicit hierarchy confirmation, model hints and atomic failure boundaries."""

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import insert, update
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.client import Proposal, Proposals
from todo_backend.main import create_app
from todo_backend.modules.sources import placement
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.schemas import ItemInput


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "placement.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as result:
        result.get("/api/session", headers={"X-Todo-Client": "web"})
        yield result


def seed(client: TestClient) -> tuple[str, str, str]:
    goal = client.post(
        "/api/items", json={"operation_id": str(uuid4()), "type": "goal", "name": "交付目标"}
    ).json()["id"]
    sid, suggestion_id = str(uuid4()), str(uuid4())
    assert (
        client.post(
            "/api/sources",
            json={
                "id": sid,
                "kind": "chat",
                "address": "oc_test",
                "enabled": True,
                "consent": True,
                "ai_consent": True,
            },
        ).status_code
        == 200
    )
    assert isinstance(client.app, FastAPI)
    with client.app.state.engine.begin() as conn:
        conn.execute(update(sources).values(content="原型下周汇报"))
        proposal = Proposal(action="new", thing_id="", name="原型汇报", evidence="原型下周汇报")
        conn.execute(
            insert(suggestions).values(
                id=suggestion_id,
                account="personal",
                source_id=sid,
                thing_id="",
                action="new",
                body=proposal.model_dump_json(),
                state="pending",
            )
        )
    return goal, sid, suggestion_id


def test_new_hierarchy_is_atomic_and_replayable(client: TestClient) -> None:
    goal, _, suggestion = seed(client)
    body = {
        "accept": True,
        "placement": {"goal_id": goal, "new_module_name": "智能输配", "new_thing_name": "原型评审"},
    }
    endpoint = f"/api/sources/suggestions/{suggestion}"
    result = client.post(endpoint, json=body)
    assert result.status_code == 200, result.text
    assert client.post(endpoint, json=body).json() == result.json()
    rows = {r["id"]: r for r in client.get("/api/items").json()}
    assert len(rows) == 4
    event = rows[result.json()["saved"]["id"]]
    thing = rows[event["parent"]]
    module = rows[thing["parent"]]
    assert (thing["name"], module["name"], module["parent"]) == ("原型评审", "智能输配", goal)


def test_existing_module_and_rejections(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    goal, _, suggestion = seed(client)
    module = client.post(
        "/api/items",
        json={"operation_id": str(uuid4()), "type": "module", "name": "已有模块", "parent": goal},
    ).json()["id"]
    path = f"/api/sources/suggestions/{suggestion}"
    selected = {"goal_id": goal, "module_id": module, "new_thing_name": "新事情"}
    assert (
        client.post(
            path, json={"accept": True, "placement": {**selected, "goal_id": str(uuid4())}}
        ).status_code
        == 422
    )
    assert (
        client.post(
            path,
            json={
                "accept": True,
                "placement": {
                    "goal_id": goal,
                    "new_module_name": "已有模块",
                    "new_thing_name": "新事情",
                },
            },
        ).status_code
        == 409
    )
    original = placement.create_work

    def fail(conn: Connection, account: str, value: ItemInput) -> str:
        if value.type == "event":
            raise SQLAlchemyError("injected event creation failure")
        return original(conn, account, value)

    monkeypatch.setattr(placement, "create_work", fail)
    assert client.post(path, json={"accept": True, "placement": selected}).status_code == 503
    assert len(client.get("/api/items").json()) == 2
    assert client.get("/api/sources/suggestions").json()[0]["state"] == "pending"
    monkeypatch.setattr(placement, "create_work", original)
    assert client.post(path, json={"accept": True, "placement": selected}).status_code == 200


def test_ai_recommendation_does_not_create_work(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    goal, sid, _ = seed(client)
    proposal = Proposal(
        action="new",
        thing_id="",
        goal_id=goal,
        new_module_name="智能输配",
        new_thing_name="原型评审",
        placement_reason="原文是原型汇报，不是合同签约",
        name="汇报原型",
        evidence="原型下周汇报",
    )
    monkeypatch.setattr(
        "todo_backend.modules.sources.recognition.recognize",
        lambda content, context: Proposals(suggestions=[proposal]),
    )
    assert isinstance(client.app, FastAPI)
    analyze_source(client.app.state.engine, sid)
    assert len(client.get("/api/items").json()) == 1
    assert len(client.get("/api/sources/suggestions").json()) == 2
    with client.app.state.engine.begin() as conn:
        conn.execute(update(sources).values(content="原型下周汇报，新消息补充", ai_hash=""))
    proposal.goal_id = str(uuid4())
    analyze_source(client.app.state.engine, sid)
    assert client.get("/api/sources").json()[0]["enabled"] is False
    assert len(client.get("/api/sources/suggestions").json()) == 2


def test_foreign_goal_rejected(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _, _, suggestion = seed(client)
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    foreign = client.post(
        "/api/items", json={"operation_id": str(uuid4()), "type": "goal", "name": "other"}
    ).json()["id"]
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    response = client.post(
        f"/api/sources/suggestions/{suggestion}",
        json={
            "accept": True,
            "placement": {"goal_id": foreign, "new_module_name": "模块", "new_thing_name": "事情"},
        },
    )
    assert response.status_code == 422
    assert len(client.get("/api/items").json()) == 1


def test_document_cannot_create_hierarchy(client: TestClient) -> None:
    goal, sid, suggestion = seed(client)
    parent = goal
    for kind in ("module", "thing"):
        parent = client.post(
            "/api/items",
            json={"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": kind},
        ).json()["id"]
    assert isinstance(client.app, FastAPI)
    with client.app.state.engine.begin() as conn:
        conn.execute(
            update(sources).where(sources.c.id == sid).values(kind="document", context=parent)
        )
        p = Proposal(action="new", thing_id=parent, name="测试事件", evidence="原型下周汇报")
        conn.execute(
            update(suggestions)
            .where(suggestions.c.id == suggestion)
            .values(thing_id=parent, body=p.model_dump_json())
        )
    endpoint = f"/api/sources/suggestions/{suggestion}"
    assert (
        client.post(
            endpoint,
            json={
                "accept": True,
                "placement": {
                    "goal_id": goal,
                    "new_module_name": "新模块",
                    "new_thing_name": "新事情",
                },
            },
        ).status_code
        == 422
    )
    assert len(client.get("/api/items").json()) == 3
    assert client.post(endpoint, json={"accept": True}).status_code == 200


def test_removed_chat_retains_placement_capability(client: TestClient) -> None:
    goal, sid, suggestion = seed(client)
    assert isinstance(client.app, FastAPI)
    with client.app.state.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(removed=True, enabled=False))
    assert client.get("/api/sources").json() == []
    assert client.get("/api/sources/suggestions").json()[0]["source_kind"] == "chat"
    response = client.post(
        f"/api/sources/suggestions/{suggestion}",
        json={
            "accept": True,
            "placement": {"goal_id": goal, "new_module_name": "新模块", "new_thing_name": "新事情"},
        },
    )
    assert response.status_code == 200, response.text
