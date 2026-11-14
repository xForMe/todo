"""Deletion is reviewed, atomic, account-scoped and preserves linked work."""

import json
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.integrations.ai.client import Proposal, Proposals
from todo_backend.main import create_app
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work import deletion
from todo_backend.modules.work.repository import deletions, items


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "delete.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as value:
        value.get("/api/session", headers={"X-Todo-Client": "web"})
        yield value


def create(client: TestClient, kind: str, parent: str | None = None) -> str:
    result = client.post(
        "/api/items",
        json={"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": kind},
    )
    assert result.status_code == 200, result.text
    return str(result.json()["id"])


def branch(client: TestClient) -> list[str]:
    result: list[str] = []
    for kind in ("goal", "module", "thing", "event"):
        result.append(create(client, kind, result[-1] if result else None))
    return result


def intent(client: TestClient, item: str, target: str | None = None) -> dict[str, object]:
    result = client.get(f"/api/items/{item}/deletion")
    assert result.status_code == 200, result.text
    return {
        "operation_id": str(uuid4()),
        "snapshot": result.json()["snapshot"],
        "target_id": target,
    }


@pytest.mark.parametrize("level", [0, 1, 2])
def test_transfer_hierarchy(client: TestClient, level: int) -> None:
    left, right = branch(client), branch(client)
    path = f"/api/items/{left[level]}/deletion"
    body = intent(client, left[level], right[level])
    assert client.post(path, json={**body, "target_id": None}).status_code == 422
    for bad in (left[level], left[level + 1], str(uuid4())):
        assert client.post(path, json={**body, "target_id": bad}).status_code == 422
    result = client.post(path, json=body)
    assert result.status_code == 200, result.text
    assert client.post(path, json=body).json() == result.json()
    assert client.get("/api/deletions/" + str(body["operation_id"])).json() == result.json()
    assert client.post(path, json={**body, "target_id": None}).status_code == 409
    current = {r["id"]: r for r in client.get("/api/items").json()}
    assert len(current) == (6 if level == 0 else 7) and left[level] not in current
    if level == 0:
        assert left[1] not in current
        assert current[left[2]]["parent"] == right[1]
        assert current[right[2]]["parent"] == right[1]
    else:
        assert current[left[level + 1]]["parent"] == right[level]
    assert current[left[3]]["status"] == "notStarted"
    assert client.get(path).status_code == 404
    assert (
        client.post(
            "/api/items",
            json={
                "operation_id": str(uuid4()),
                "type": ("module", "thing", "event")[level],
                "parent": left[level],
                "name": "late",
            },
        ).status_code
        == 404
    )


def test_empty_stale_scope_and_rollback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    left, right = branch(client), branch(client)
    path = f"/api/items/{left[0]}/deletion"
    body = intent(client, left[0], right[0])
    create(client, "module", left[0])
    assert client.post(path, json=body).status_code == 409
    body = intent(client, left[0], right[0])
    original = deletion.transfer

    def fail(conn: Connection, account: str, item_id: str, target_id: str | None) -> None:
        original(conn, account, item_id, target_id)
        raise SQLAlchemyError("injected after transfer")

    monkeypatch.setattr(deletion, "transfer", fail)
    assert client.post(path, json=body).status_code == 503
    assert client.get("/api/deletions/" + str(body["operation_id"])).status_code == 404
    current = {r["id"]: r for r in client.get("/api/items").json()}
    assert current[left[1]]["parent"] == left[0]
    monkeypatch.setattr(deletion, "transfer", original)
    empty = create(client, "goal")
    assert (
        client.post(f"/api/items/{empty}/deletion", json=intent(client, empty)).status_code == 200
    )
    monkeypatch.setenv("TODO_OWNER_ID", "foreign")
    assert client.get(path).status_code == 404
    foreign = create(client, "goal")
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    assert client.post(path, json=intent(client, left[0], foreign)).status_code == 422


def test_sources_suggestions_and_reminder_preserved(client: TestClient) -> None:
    left, right = branch(client), branch(client)
    sid = str(uuid4())
    assert (
        client.post(
            "/api/sources",
            json={
                "id": sid,
                "kind": "document",
                "context": left[2],
                "address": "https://example.feishu.cn/wiki/Test",
                "enabled": True,
                "consent": True,
                "ai_consent": True,
            },
        ).status_code
        == 200
    )
    assert isinstance(client.app, FastAPI)
    engine = client.app.state.engine
    from todo_backend.modules.sources.follow import attempts, rules

    with engine.begin() as conn:
        proposal = Proposal(
            action="update", thing_id=left[2], event_id=left[3], name="新标题", evidence="原文"
        )
        suggestion_id = str(uuid4())
        conn.execute(
            insert(suggestions).values(
                id=suggestion_id,
                account="personal",
                source_id=sid,
                thing_id=left[2],
                event_id=left[3],
                event_version=1,
                action="update",
                body=proposal.model_dump_json(),
                state="pending",
            )
        )
        conn.execute(
            insert(rules).values(
                event_id=left[3],
                account="personal",
                recipient="ou_test",
                content="催办",
                at="09:00",
                cap=3,
                count=1,
                enabled=True,
                event_version=1,
                version=1,
                next_run=9999999999,
                status="等待",
            )
        )
        conn.execute(
            insert(attempts).values(
                id=str(uuid4()),
                account="personal",
                event_id=left[3],
                created=1,
                content="历史消息",
                state="confirmed",
                message_id="om_history",
            )
        )
    path = f"/api/items/{left[2]}/deletion"
    assert client.post(path, json=intent(client, left[2], right[2])).status_code == 200
    source = client.get("/api/sources").json()[0]
    assert source["context"] == right[2] and source["enabled"] is False
    suggestion = client.get("/api/sources/suggestions").json()[0]
    assert suggestion["thing_id"] == right[2]
    assert json.loads(suggestion["body"])["thing_id"] == right[2]
    reminder = client.get("/api/sources/follow").json()[0]
    assert reminder["enabled"] is False and reminder["count"] == 1
    assert reminder["logs"][0]["message_id"] == "om_history"
    accepted = client.post(f"/api/sources/suggestions/{suggestion_id}", json={"accept": True})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["saved"]["parent"] == right[2]


def test_stale_ai_and_database_fence(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    left, right = branch(client), branch(client)
    sid = str(uuid4())
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
    engine = client.app.state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).values(content="原文"))

    def recognize(content: str, context: str) -> Proposals:
        path = f"/api/items/{left[2]}/deletion"
        assert client.post(path, json=intent(client, left[2], right[2])).status_code == 200
        return Proposals(
            suggestions=[
                Proposal(action="new", thing_id=left[2], name="过期识别", evidence=content)
            ]
        )

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", recognize)
    analyze_source(engine, sid)
    assert client.get("/api/sources/suggestions").json() == []
    with engine.connect() as conn:
        assert conn.execute(select(deletions.c.item_id)).scalar_one() == left[2]
    with pytest.raises(SQLAlchemyError), engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == right[3]).values(parent=left[2]))


@pytest.mark.parametrize("level", [0, 1, 2])
def test_empty_level_and_deleted_destination(client: TestClient, level: int) -> None:
    current = branch(client)
    kind = ("goal", "module", "thing")[level]
    parent = current[level - 1] if level else None
    empty = create(client, kind, parent)
    target = create(client, kind, parent)
    path = f"/api/items/{empty}/deletion"
    assert (
        client.post(f"/api/items/{target}/deletion", json=intent(client, target)).status_code == 200
    )
    assert client.post(path, json=intent(client, empty, target)).status_code == 422
    assert client.post(path, json=intent(client, empty)).status_code == 200


def test_source_only_and_inflight_proposal(client: TestClient) -> None:
    current = branch(client)
    empty = create(client, "thing", current[1])
    sid = str(uuid4())
    assert (
        client.post(
            "/api/sources",
            json={
                "id": sid,
                "kind": "document",
                "context": empty,
                "address": "https://example.feishu.cn/wiki/SourceOnly",
            },
        ).status_code
        == 200
    )
    path = f"/api/items/{empty}/deletion"
    impact = client.get(path).json()
    assert impact["children"] == 0 and impact["requires_target"] is True
    assert client.post(path, json=intent(client, empty)).status_code == 422
    assert isinstance(client.app, FastAPI)
    engine = client.app.state.engine
    with engine.begin() as conn:
        proposal = Proposal(action="new", thing_id=empty, name="待应用", evidence="原文")
        conn.execute(
            insert(suggestions).values(
                id=str(uuid4()),
                account="personal",
                source_id=sid,
                thing_id=empty,
                action="new",
                body=proposal.model_dump_json(),
                state="applying",
            )
        )
    assert client.get(path).status_code == 409


def test_module_fusion_preserves_both_sides(client: TestClient) -> None:
    left, right = branch(client), branch(client)
    assert isinstance(client.app, FastAPI)
    engine = client.app.state.engine
    with engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == left[1]).values(description="来源说明"))
        conn.execute(update(items).where(items.c.id == right[1]).values(description="接收方说明"))
    sid = str(uuid4())
    assert (
        client.post(
            "/api/sources",
            json={
                "id": sid,
                "kind": "document",
                "context": left[2],
                "address": "https://example.feishu.cn/wiki/Merge",
                "enabled": True,
                "consent": True,
            },
        ).status_code
        == 200
    )
    path = f"/api/items/{left[0]}/deletion"
    body = intent(client, left[0], right[0])
    result = client.post(path, json=body)
    assert result.status_code == 200, result.text
    assert client.post(path, json=body).json() == result.json()
    rows = {r["id"]: r for r in client.get("/api/items").json()}
    assert [r["id"] for r in rows.values() if r["type"] == "module"] == [right[1]]
    assert rows[right[1]]["description"] == "接收方说明\n\n来源说明"
    assert rows[left[2]]["parent"] == rows[right[2]]["parent"] == right[1]
    assert rows[left[3]]["parent"] == left[2] and rows[right[3]]["parent"] == right[2]
    source = client.get("/api/sources").json()[0]
    assert source["context"] == left[2] and source["enabled"] is False


def test_different_module_names_remain_separate(client: TestClient) -> None:
    left, right = branch(client), branch(client)
    assert isinstance(client.app, FastAPI)
    with client.app.state.engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == left[1]).values(name="different"))
    assert (
        client.post(
            f"/api/items/{left[0]}/deletion", json=intent(client, left[0], right[0])
        ).status_code
        == 200
    )
    rows = client.get("/api/items").json()
    assert len([r for r in rows if r["type"] == "module"]) == 2


def test_fusion_description_overflow_rolls_back(client: TestClient) -> None:
    left, right = branch(client), branch(client)
    assert isinstance(client.app, FastAPI)
    with client.app.state.engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == left[1]).values(description="a" * 6000))
        conn.execute(update(items).where(items.c.id == right[1]).values(description="b" * 6000))
    result = client.post(f"/api/items/{left[0]}/deletion", json=intent(client, left[0], right[0]))
    assert result.status_code == 422
    rows = {r["id"]: r for r in client.get("/api/items").json()}
    assert len(rows) == 8 and rows[left[1]]["parent"] == left[0]
