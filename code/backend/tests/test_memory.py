"""Selective memory behavior: scope, replay, capacity and late-result rejection."""

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update

from todo_backend.integrations.ai.embeddings import EmbeddingConfig, EmbeddingError, validate_vector
from todo_backend.main import create_app
from todo_backend.modules.memory import indexing, service
from todo_backend.modules.memory.repository import cards
from todo_backend.modules.memory.retrieval import memory_context
from todo_backend.modules.memory.schemas import CardInput
from todo_backend.modules.sources import recognition
from todo_backend.modules.sources.repository import sources
from todo_backend.modules.work.repository import items


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "memory.db"))
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "1")
    monkeypatch.setenv("TODO_EMBEDDING_SOURCE_CONSENT", "0")
    monkeypatch.setenv("TODO_EMBEDDING_CONSENT", "0")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as result:
        result.get("/api/session", headers={"X-Todo-Client": "web"})
        yield result


def module(client: TestClient, name: str = "A项目") -> str:
    goal = client.post(
        "/api/items", json={"operation_id": str(uuid4()), "type": "goal", "name": "交付"}
    ).json()["id"]
    return str(
        client.post(
            "/api/items",
            json={"operation_id": str(uuid4()), "type": "module", "name": name, "parent": goal},
        ).json()["id"]
    )


def body(client: TestClient, mid: str, description: str = "负责联调和验收") -> dict[str, object]:
    current = client.get(f"/api/memory/modules/{mid}").json()["card"]
    return {
        "operation_id": str(uuid4()),
        "expected_version": current["version"],
        "scope_version": current["scope_version"],
        "description": description,
        "aliases": ["华东一期"],
        "enabled": True,
    }


def app_of(client: TestClient) -> FastAPI:
    assert isinstance(client.app, FastAPI)
    return client.app


def test_confirm_replay_conflict_and_no_automatic_vectors(client: TestClient) -> None:
    mid = module(client)
    data = body(client, mid)
    url = f"/api/memory/modules/{mid}"
    saved = client.put(url, json=data)
    assert saved.status_code == 200, saved.text
    assert client.put(url, json=data).json() == saved.json()
    assert client.put(url, json={**data, "description": "其他"}).status_code == 409
    assert client.put(url, json={**data, "operation_id": str(uuid4())}).status_code == 409
    assert client.get("/api/memory/operations/" + str(data["operation_id"])).json() == saved.json()
    with app_of(client).state.engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM memory_vectors")).scalar_one() == 0
        assert len(conn.execute(select(items)).all()) == 2


def test_cross_account_and_nonmodule_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid = module(client)
    data = body(client, mid)
    client.put(f"/api/memory/modules/{mid}", json=data)
    monkeypatch.setenv("TODO_OWNER_ID", "another")
    assert client.get(f"/api/memory/modules/{mid}").status_code == 404
    assert client.put(f"/api/memory/modules/{mid}", json=data).status_code == 404
    assert client.get("/api/memory/operations/" + str(data["operation_id"])).status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    goal = client.get("/api/items").json()[0]["id"]
    assert client.get(f"/api/memory/modules/{goal}").status_code == 404


def test_scope_change_and_disable_remove_context(client: TestClient) -> None:
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    engine = app_of(client).state.engine
    assert mid in memory_context(engine, "personal", "华东一期").text
    with engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == mid).values(name="改名", version=2))
    assert memory_context(engine, "personal", "华东一期").text == ""
    assert not client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"]
    assert client.put(f"/api/memory/modules/{mid}", json=body(client, mid)).status_code == 200
    disabled = {**body(client, mid), "enabled": False}
    assert client.put(f"/api/memory/modules/{mid}", json=disabled).status_code == 200
    assert memory_context(engine, "personal", "华东一期").text == ""


def test_document_context_never_includes_other_module(client: TestClient) -> None:
    first, second = module(client), module(client, "B项目")
    for mid in (first, second):
        client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    thing = client.post(
        "/api/items",
        json={"operation_id": str(uuid4()), "type": "thing", "name": "上线", "parent": first},
    ).json()["id"]
    context = memory_context(app_of(client).state.engine, "personal", "华东一期", thing)
    assert first in context.text and second not in context.text
    assert memory_context(app_of(client).state.engine, "personal", "华东一期", "missing").text == ""


def test_budgets_and_input_rejections(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = module(client), module(client, "B项目")
    monkeypatch.setattr(service, "MAX_CARDS", 1)
    assert client.put(f"/api/memory/modules/{first}", json=body(client, first)).status_code == 200
    assert client.put(f"/api/memory/modules/{second}", json=body(client, second)).status_code == 409
    assert (
        client.put(
            f"/api/memory/modules/{first}", json={**body(client, first), "aliases": ["x", "x"]}
        ).status_code
        == 422
    )
    assert (
        client.put(f"/api/memory/modules/{first}", json=body(client, first, "x" * 2001)).status_code
        == 422
    )
    assert (
        client.put(f"/api/memory/modules/{first}", json=body(client, first, "更新职责")).status_code
        == 200
    )
    monkeypatch.setattr(service, "MAX_OPERATIONS", 2)
    assert client.put(f"/api/memory/modules/{first}", json=body(client, first)).status_code == 409


def mock_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        indexing,
        "configuration",
        lambda: EmbeddingConfig("https://example.test/embeddings", "test", 3, "not-a-key", "v1"),
    )
    monkeypatch.setattr(indexing, "embed", lambda content, config: [1.0, 0.0, 0.0])


def test_index_replay_and_correction_clear_vectors(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_embedding(monkeypatch)
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    data = {"operation_id": str(uuid4()), "expected_version": 1}
    endpoint = f"/api/memory/modules/{mid}/index"
    assert client.post(endpoint, json=data).json() == {"state": "ready"}

    def forbidden(content: str, config: EmbeddingConfig) -> list[float]:
        raise AssertionError("Replay must never call provider")

    monkeypatch.setattr(indexing, "embed", forbidden)
    assert client.post(endpoint, json=data).json() == {"state": "ready"}
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid, "新职责"))
    with app_of(client).state.engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM memory_vectors")).scalar_one() == 0
    assert client.post(endpoint, json=data).status_code == 409


def test_late_index_response_cannot_restore_old_card(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_embedding(monkeypatch)
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    changed = CardInput.model_validate({**body(client, mid), "enabled": False})
    engine = app_of(client).state.engine

    def delayed(content: str, config: EmbeddingConfig) -> list[float]:
        service.save_card(engine, "personal", mid, changed)
        return [1.0, 0.0, 0.0]

    monkeypatch.setattr(indexing, "embed", delayed)
    response = client.post(
        f"/api/memory/modules/{mid}/index",
        json={"operation_id": str(uuid4()), "expected_version": 1},
    )
    assert response.status_code == 409
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM memory_vectors")).scalar_one() == 0


def test_index_failure_is_not_retried(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    mock_embedding(monkeypatch)
    calls = []

    def fail(content: str, config: EmbeddingConfig) -> list[float]:
        calls.append(content)
        raise EmbeddingError("合成失败")

    monkeypatch.setattr(indexing, "embed", fail)
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    data = {"operation_id": str(uuid4()), "expected_version": 1}
    endpoint = f"/api/memory/modules/{mid}/index"
    assert client.post(endpoint, json=data).status_code == 502
    assert client.post(endpoint, json=data).json() == {"state": "failed"}
    assert len(calls) == 1


@pytest.mark.parametrize("value", [[0, 0], [1], [True, 1], [float("nan"), 1], [float("inf"), 1]])
def test_vector_contract(value: object) -> None:
    with pytest.raises(EmbeddingError):
        validate_vector(value, 2)


def test_capacity_still_allows_revocation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    monkeypatch.setattr(service, "MAX_OPERATIONS", 1)
    assert client.put(f"/api/memory/modules/{mid}", json=body(client, mid)).status_code == 409
    response = client.put(
        f"/api/memory/modules/{mid}", json={**body(client, mid), "enabled": False}
    )
    assert response.status_code == 200
    assert response.json()["usable"] is False
    assert memory_context(app_of(client).state.engine, "personal", "华东一期").text == ""


def test_changed_embedding_profile_does_not_report_ready(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.api import memory

    mock_embedding(monkeypatch)
    monkeypatch.setattr(
        memory,
        "configuration",
        lambda: EmbeddingConfig("https://example.test/embeddings", "test", 3, "not-a-key", "v1"),
    )
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    client.post(
        f"/api/memory/modules/{mid}/index",
        json={"operation_id": str(uuid4()), "expected_version": 1},
    )
    assert client.get(f"/api/memory/modules/{mid}").json()["index_state"] == "ready"
    monkeypatch.setattr(
        memory,
        "configuration",
        lambda: EmbeddingConfig(
            "https://example.test/embeddings", "other-model", 3, "not-a-key", "v1"
        ),
    )
    assert client.get(f"/api/memory/modules/{mid}").json()["index_state"] == "not_indexed"


def test_recognition_uses_memory_and_discards_changed_context(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.integrations.ai.client import Proposals

    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    sid = str(uuid4())
    response = client.post(
        "/api/sources",
        json={
            "id": sid,
            "kind": "chat",
            "address": "oc_memory",
            "enabled": True,
            "consent": True,
            "ai_consent": True,
            "interval": 900,
        },
    )
    assert response.status_code == 200, response.text
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content="华东一期接口联调"))
    changed = CardInput.model_validate({**body(client, mid), "enabled": False})

    def recognize(content: str, context: str) -> Proposals:
        assert "负责联调和验收" in context
        service.save_card(engine, "personal", mid, changed)
        return Proposals(suggestions=[])

    monkeypatch.setattr(recognition, "recognize", recognize)
    recognition.analyze_source(engine, sid)
    with engine.connect() as conn:
        assert conn.execute(select(sources.c.ai_hash).where(sources.c.id == sid)).scalar_one() == ""
        assert (
            conn.execute(select(cards.c.enabled).where(cards.c.module_id == mid)).scalar_one()
            is False
        )


def test_native_vector_search_filters_profile_revision_and_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.memory import retrieval

    engine = app_of(client).state.engine
    if engine.dialect.name != "postgresql":
        pytest.skip("Native pgvector requires an explicitly isolated PostgreSQL test database")
    mock_embedding(monkeypatch)
    config = EmbeddingConfig("https://example.test/embeddings", "test", 3, "not-a-key", "v1")
    monkeypatch.setattr(retrieval, "configuration", lambda: config)
    monkeypatch.setattr(retrieval, "embed", lambda content, profile: [1.0, 0.0, 0.0])
    monkeypatch.setenv("TODO_EMBEDDING_SOURCE_CONSENT", "1")
    targets = [module(client, f"原生模块{i}") for i in range(12)]
    best = sorted(targets)[-1]
    for mid in targets:
        data = body(client, mid, "最相关的候选" if mid == best else "普通模块")
        client.put(f"/api/memory/modules/{mid}", json=data)
        response = client.post(
            f"/api/memory/modules/{mid}/index",
            json={
                "operation_id": str(uuid4()),
                "expected_version": 1,
            },
        )
        assert response.json() == {"state": "ready"}
    excluded = sorted(targets)[:2]
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE memory_vectors SET embedding='[0,1,0]'::public.vector "
                "WHERE module_id<>:best"
            ),
            {"best": best},
        )
        conn.execute(
            text(
                "UPDATE memory_vectors SET profile='old-profile', "
                "embedding='[1,0]'::public.vector WHERE module_id=:id"
            ),
            {"id": excluded[0]},
        )
        conn.execute(
            text("UPDATE memory_vectors SET revision=999 WHERE module_id=:id"), {"id": excluded[1]}
        )
        conn.execute(
            text(
                "INSERT INTO memory_vectors VALUES ('foreign', :id, 1, :p, '[1,0]'::public.vector)"
            ),
            {"id": best, "p": config.profile},
        )
    result = memory_context(engine, "personal", "unrelated query without exact names")
    assert result.status.startswith("hybrid"), result.status
    assert "最相关的候选" in result.text
    assert all(mid not in result.text for mid in excluded)


def test_native_vector_document_never_searches_other_module(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.memory import retrieval

    engine = app_of(client).state.engine
    if engine.dialect.name != "postgresql":
        pytest.skip("Native pgvector requires an explicitly isolated PostgreSQL test database")
    mock_embedding(monkeypatch)
    monkeypatch.setattr(
        retrieval,
        "configuration",
        lambda: EmbeddingConfig("https://example.test/embeddings", "test", 3, "not-a-key", "v1"),
    )
    monkeypatch.setattr(retrieval, "embed", lambda content, profile: [1.0, 0.0, 0.0])
    monkeypatch.setenv("TODO_EMBEDDING_SOURCE_CONSENT", "1")
    mine, other = module(client, "允许模块"), module(client, "禁止模块")
    for mid in (mine, other):
        client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
        client.post(
            f"/api/memory/modules/{mid}/index",
            json={
                "operation_id": str(uuid4()),
                "expected_version": 1,
            },
        )
    thing = client.post(
        "/api/items",
        json={
            "operation_id": str(uuid4()),
            "type": "thing",
            "parent": mine,
            "name": "授权事情",
        },
    ).json()["id"]
    result = memory_context(engine, "personal", "禁止模块", thing)
    assert result.status.startswith("hybrid")
    assert mine in result.text and other not in result.text and "禁止模块" not in result.text
