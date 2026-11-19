"""Current summaries retain facts, bound storage and reject stale or foreign scope."""

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
from sqlalchemy import select, text, update
from sqlalchemy.engine import Connection

from todo_backend.main import create_app
from todo_backend.modules.memory import working
from todo_backend.modules.memory.context import bounded_directory, build_context
from todo_backend.modules.memory.repository import working_summaries as cache
from todo_backend.modules.memory.schemas import MemoryContext, WorkingSummary
from todo_backend.modules.sources import recognition
from todo_backend.modules.sources.repository import sources
from todo_backend.modules.work.repository import items


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "working.db"))
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "1")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as result:
        result.get("/api/session", headers={"X-Todo-Client": "web"})
        yield result


def app_of(client: TestClient) -> FastAPI:
    assert isinstance(client.app, FastAPI)
    return client.app


def create(client: TestClient, kind: str, parent: str | None, name: str) -> str:
    response = client.post(
        "/api/items",
        json={
            "operation_id": str(uuid4()),
            "type": kind,
            "parent": parent,
            "name": name,
        },
    )
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


def hierarchy(client: TestClient) -> tuple[str, str, str]:
    goal = create(client, "goal", None, "客户交付")
    module = create(client, "module", goal, "华东一期")
    thing = create(client, "thing", module, "上线准备")
    return goal, module, thing


def refresh(client: TestClient, thing_id: str) -> dict[str, object]:
    response = client.post(f"/api/memory/working/{thing_id}/refresh")
    assert response.status_code == 200, response.text
    result: dict[str, object] = response.json()
    return result


def test_current_summary_is_one_bounded_projection(client: TestClient) -> None:
    _, _, thing = hierarchy(client)
    for number in range(13):
        create(client, "event", thing, f"联调工作{number}")
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(
            update(items)
            .where(items.c.parent == thing)
            .values(
                owner="李工",
                planEnd="2026-12-01",
                description="明确的业务说明" * 200,
            )
        )
    first = refresh(client, thing)
    assert refresh(client, thing) == first
    summary = first["summary"]
    assert isinstance(summary, dict)
    assert summary["counts"] == {"notStarted": 13, "working": 0, "completed": 0, "cancelled": 0}
    assert summary["partial"] is True
    assert isinstance(summary["actions"], list)
    assert len(summary["actions"]) + int(str(summary["omitted"])) == 13
    with engine.connect() as conn:
        rows = conn.execute(select(cache)).mappings().all()
        assert len(rows) == 1 and len(rows[0]["body"]) <= 4000
        assert conn.execute(text("SELECT COUNT(*) FROM memory_vectors")).scalar_one() == 0
        assert len(conn.execute(select(items.c.id)).all()) == 16
    with engine.begin() as conn:
        conn.execute(
            update(items)
            .where(items.c.parent == thing)
            .values(
                status="completed",
                version=items.c.version + 1,
            )
        )
    changed = refresh(client, thing)
    assert changed["fingerprint"] != first["fingerprint"]
    assert isinstance(changed["summary"], dict)
    assert changed["summary"]["actions"] == []


def test_ended_summary_removed_and_reopened_from_facts(client: TestClient) -> None:
    _, _, thing = hierarchy(client)
    event = create(client, "event", thing, "长期未处理但不能遗忘")
    first = refresh(client, thing)
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == thing).values(status="completed", version=2))
    assert refresh(client, thing)["state"] == "inactive"
    with engine.connect() as conn:
        assert conn.execute(select(cache)).first() is None
        assert conn.execute(select(items.c.id).where(items.c.id == event)).scalar_one() == event
    with engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == thing).values(status="working", version=3))
    reopened = refresh(client, thing)
    assert reopened["state"] == "cached"
    assert reopened["fingerprint"] != first["fingerprint"]
    assert "长期未处理但不能遗忘" in json.dumps(reopened, ensure_ascii=False)


def test_scope_capacity_and_corrupt_cache_are_safe(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, module, thing = hierarchy(client)
    other = create(client, "thing", module, "其他工作")
    refresh(client, thing)
    monkeypatch.setattr(working, "MAX_SUMMARIES", 1)
    assert refresh(client, other)["state"] == "capacity_uncached"
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(cache).where(cache.c.thing_id == thing).values(body="过时正文"))
    assert "过时正文" not in json.dumps(refresh(client, thing), ensure_ascii=False)
    monkeypatch.setenv("TODO_OWNER_ID", "another-account")
    assert client.post(f"/api/memory/working/{thing}/refresh").status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    assert client.post(f"/api/memory/working/{module}/refresh").status_code == 404
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "0")
    assert client.post(f"/api/memory/working/{thing}/refresh").status_code == 409


def test_moved_event_leaves_old_summary_and_changes_new(client: TestClient) -> None:
    _, module, thing = hierarchy(client)
    other = create(client, "thing", module, "接收工作")
    event = create(client, "event", thing, "不能留在旧摘要")
    refresh(client, thing)
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == event).values(parent=other, version=2))
    assert "不能留在旧摘要" not in json.dumps(refresh(client, thing), ensure_ascii=False)
    assert "不能留在旧摘要" in json.dumps(refresh(client, other), ensure_ascii=False)


def test_summary_readback_rejects_changed_business_state(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, thing = hierarchy(client)
    original = working.snapshot
    calls = 0
    engine = app_of(client).state.engine

    def changed_snapshot(conn: Connection, account: str, target: str) -> tuple[WorkingSummary, str]:
        nonlocal calls
        calls += 1
        if calls == 2:
            with engine.begin() as writer:
                writer.execute(
                    update(items).where(items.c.id == thing).values(name="更名", version=2)
                )
        return original(conn, account, target)

    monkeypatch.setattr(working, "snapshot", changed_snapshot)
    assert client.post(f"/api/memory/working/{thing}/refresh").status_code == 409


def test_raw_descriptions_never_enter_summary(client: TestClient) -> None:
    _, _, thing = hierarchy(client)
    with app_of(client).state.engine.begin() as conn:
        conn.execute(
            update(items).where(items.c.id == thing).values(description="源消息原文不应重发")
        )
    event = create(client, "event", thing, "已确认行动")
    with app_of(client).state.engine.begin() as conn:
        conn.execute(update(items).where(items.c.id == event).values(description="事件引用的原文"))
    summary = refresh(client, thing)
    assert "原文" not in json.dumps(summary, ensure_ascii=False)
    with app_of(client).state.engine.connect() as conn:
        assert len(conn.execute(select(cache.c.body)).scalar_one()) <= 4000


def test_directory_keeps_matched_event_and_ancestors_inside_budget() -> None:
    entries: list[dict[str, object]] = [
        {
            "id": str(i),
            "name": f"历史工作{i}",
            "type": "event",
            "parent": "t",
            "status": "completed",
            "path": "交付/项目/事情/历史工作" + str(i),
        }
        for i in range(100)
    ]
    entries += [
        {"id": "g", "name": "交付", "type": "goal", "parent": None, "status": "notStarted"},
        {"id": "m", "name": "项目", "type": "module", "parent": "g", "status": "notStarted"},
        {"id": "t", "name": "事情", "type": "thing", "parent": "m", "status": "working"},
    ]
    result, partial = bounded_directory(entries, "历史工作99", 1200)
    ids = {entry["id"] for entry in json.loads(result)}
    assert {"g", "m", "t", "99"} <= ids
    assert partial and len(result) <= 1200


def test_context_total_budget_and_document_scope(client: TestClient) -> None:
    _, module, thing = hierarchy(client)
    other = create(client, "thing", module, "别的事情秘密")
    create(client, "event", thing, "接口验收")
    create(client, "event", other, "别的事件秘密")
    engine = app_of(client).state.engine
    with engine.connect() as conn:
        scope = list(
            conn.execute(
                select(items).where((items.c.id == thing) | (items.c.parent == thing))
            ).mappings()
        )
    result = build_context(
        engine,
        "personal",
        recognition.work_context(scope),
        "接口验收",
        MemoryContext(text="模块提示", status="exact"),
    )
    assert result.working_count == 1
    assert "秘密" not in result.text
    long_content = "x" * 28500
    limited = build_context(
        engine,
        "personal",
        recognition.work_context(scope),
        long_content,
        MemoryContext(text="y" * 6000, status="exact"),
    )
    assert len(long_content) + len(limited.text) <= 30000
    assert limited.partial


def test_recognition_automatically_adds_current_summary(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.integrations.ai.client import Proposals

    _, _, thing = hierarchy(client)
    create(client, "event", thing, "接口验收")
    sid = str(uuid4())
    response = client.post(
        "/api/sources",
        json={
            "id": sid,
            "kind": "chat",
            "address": "oc_working",
            "enabled": True,
            "consent": True,
            "ai_consent": True,
            "interval": 900,
        },
    )
    assert response.status_code == 200
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content="接口验收准备"))
        conn.execute(update(items).where(items.c.parent == thing).values(owner="业务负责人"))

    def recognize(content: str, context: str) -> Proposals:
        assert "当前工作摘要" in context and "业务负责人" in context
        return Proposals(suggestions=[])

    monkeypatch.setattr(recognition, "recognize", recognize)
    recognition.analyze_source(engine, sid)
    with engine.connect() as conn:
        assert conn.execute(select(cache.c.thing_id)).scalar_one() == thing
        assert "当前摘要 1 份" in conn.execute(select(sources.c.status)).scalar_one()
