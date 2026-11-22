"""Verify MCP discovery and historical draft services with isolated data."""

import json
from collections.abc import Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import cast
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Engine, func, inspect, select
from test_work import payload

from todo_backend.integrations.ai.client import AIError
from todo_backend.integrations.ai.endpoint import ModelTarget
from todo_backend.main import create_app
from todo_backend.modules import dsh_capture
from todo_backend.modules.sources.repository import suggestions
from todo_backend.modules.work.repository import items
from todo_backend.modules.work.service import WorkError


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "capture.db"))
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 2000)) as web:
        assert web.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        yield web


TOKEN = "capture-test-token-" + "x" * 32
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json, text/event-stream"}
EVIDENCE = "2026-11-27 前整理接口验收清单，负责人：王月"


def rpc(client: TestClient, method: str, params: dict[str, object], **headers: str) -> Response:
    reply = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        headers={**HEADERS, **headers},
    )
    return cast(Response, reply)


def call(client: TestClient, name: str, args: Mapping[str, object]) -> dict[str, object]:
    reply = rpc(client, "tools/call", {"name": name, "arguments": args})
    assert reply.status_code == 200, reply.text
    return cast(dict[str, object], reply.json()["result"])


def value(result: dict[str, object]) -> dict[str, object]:
    assert not result.get("isError"), result
    blocks = cast(list[dict[str, str]], result["content"])
    return cast(dict[str, object], json.loads(blocks[0]["text"]))


def tree(client: TestClient) -> tuple[str, str, str]:
    ids: list[str] = []
    for kind, name in (("goal", "交付"), ("module", "接口"), ("thing", "联调准备")):
        reply = client.post(
            "/api/items", json={**payload(kind, ids[-1] if ids else None), "name": name}
        )
        assert reply.status_code == 200, reply.text
        ids.append(reply.json()["id"])
    return ids[0], ids[1], ids[2]


def configure(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    model_id = str(uuid4())
    reply = client.put(
        "/api/model-catalog",
        json={
            "operation_id": str(uuid4()),
            "expected_revision": 0,
            "models": [
                {
                    "id": model_id,
                    "name": "合成模型",
                    "model": "capture",
                    "base_url": "https://model.example/v1",
                }
            ],
            "assignments": {},
        },
    )
    assert reply.status_code == 200, reply.text
    assert reply.json()["assignments"] == {}
    assert "dsh_capture" not in reply.json()["scenes"]
    monkeypatch.setenv("TODO_DSH_CAPTURE_MODEL_ID", model_id)


def engine(client: TestClient) -> Engine:
    return cast(Engine, cast(FastAPI, client.app).state.engine)


def test_native_auth_and_tool_discovery(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", "")
    assert rpc(client, "tools/list", {}).status_code == 404
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", TOKEN)
    assert rpc(client, "tools/list", {}, Authorization="").status_code == 401
    assert rpc(client, "tools/list", {}, Authorization="Bearer incorrect").status_code == 401
    # Node's native fetch sends this without a browser origin or a fetch-site header.
    assert rpc(client, "tools/list", {}, **{"Sec-Fetch-Mode": "cors"}).status_code == 200
    for headers in (
        {"Origin": "http://127.0.0.1"},
        {"Sec-Fetch-Site": "same-origin"},
        {"X-Forwarded-For": "127.0.0.1"},
        {"Forwarded": "for=127.0.0.1"},
    ):
        assert rpc(client, "tools/list", {}, **headers).status_code == 403
    assert rpc(client, "tools/list", {}, Host="external.example").status_code == 400
    with TestClient(
        create_app(), base_url="http://127.0.0.1", client=("192.0.2.1", 2000)
    ) as remote:
        assert rpc(remote, "tools/list", {}).status_code == 403
    assert (
        rpc(
            client,
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        ).json()["result"]["serverInfo"]["name"]
        == "To Do Capture"
    )
    assert {tool["name"] for tool in rpc(client, "tools/list", {}).json()["result"]["tools"]} == {
        "find_matters",
        "get_recorded_event",
        "get_event_to_complete",
    }
    for former_write_tool in (
        "prepare_capture",
        "get_capture",
        "confirm_capture",
        "event_completion",
    ):
        assert call(client, former_write_tool, {"confirmed": True}).get("isError") is True
    large = client.post(
        "/mcp", content=b"x" * 65537, headers={**HEADERS, "Content-Type": "application/json"}
    )
    assert large.status_code == 413


def test_prepare_read_replay_and_no_formal_writes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", TOKEN)
    configure(client, monkeypatch)
    goal, module, matter = tree(client)
    calls = 0

    def fake(_prompt: str, text: str, context: str, target: ModelTarget) -> object:
        nonlocal calls
        calls += 1
        assert target.model == "capture" and text == f"请记一下：{EVIDENCE}。额外备注不要复述。"
        assert matter in context and "联调准备" in context
        return {
            "candidate": {
                "title": "整理接口验收清单",
                "planned_date": "2026-11-27",
                "owner": "王月",
                "evidence": EVIDENCE,
                "goal_id": goal,
                "module_id": module,
                "matter_id": matter,
                "reason": "联调准备",
            }
        }

    monkeypatch.setattr(dsh_capture, "call_json", fake)
    operation = uuid4()
    identifier = str(operation)
    text = f"请记一下：{EVIDENCE}。额外备注不要复述。"
    db = engine(client)
    result = dsh_capture.prepare(db, "personal", operation, text).model_dump(mode="json")
    candidate = cast(dict[str, object], result["candidate"])
    assert (candidate["title"], candidate["planned_date"], candidate["owner"]) == (
        "整理接口验收清单",
        "2026-11-27",
        "王月",
    )
    assert cast(dict[str, object], candidate["path"])["matter_id"] == matter
    assert "额外备注不要复述" not in json.dumps(result, ensure_ascii=False)
    assert dsh_capture.prepare(db, "personal", operation, text).model_dump(mode="json") == result
    assert dsh_capture.read(db, "personal", operation).model_dump(mode="json") == result
    with pytest.raises(WorkError) as conflict:
        dsh_capture.prepare(db, "personal", operation, "不同的提交")
    assert conflict.value.status == 409
    assert calls == 1
    web_path = f"/api/dsh-captures/{identifier}"
    readback = client.get(web_path)
    assert readback.json() == result and readback.headers["cache-control"] == "no-store"
    assert client.post(web_path, json={"confirmed": True}).status_code == 405
    with TestClient(create_app(), base_url="http://127.0.0.1") as another:
        assert another.get(web_path, headers=HEADERS).status_code == 401
    with monkeypatch.context() as other:
        other.setenv("TODO_OWNER_ID", "foreign-capture-account")
        assert client.get(web_path).status_code == 404
        with pytest.raises(WorkError) as hidden:
            dsh_capture.read(db, "foreign-capture-account", operation)
        assert hidden.value.status == 404
    with engine(client).connect() as conn:
        assert conn.scalar(select(func.count()).select_from(items)) == 3
        assert conn.scalar(select(func.count()).select_from(suggestions)) == 0


def test_unassigned_failure_and_manual_recovery(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DSH_CAPTURE_MODEL_ID", "")
    db, operation = engine(client), uuid4()
    text = "请记一下验收"
    with pytest.raises(WorkError):
        dsh_capture.prepare(db, "personal", operation, text)
    configure(client, monkeypatch)
    calls = 0

    def fake(*_: object) -> object:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise AIError("模型暂不可用")
        return {"candidate": None}

    monkeypatch.setattr(dsh_capture, "call_json", fake)
    with pytest.raises(WorkError):
        dsh_capture.prepare(db, "personal", operation, text)
    with pytest.raises(WorkError) as missing:
        dsh_capture.read(db, "personal", operation)
    assert missing.value.status == 404
    assert calls == 1
    assert dsh_capture.prepare(db, "personal", operation, text).candidate is None
    assert calls == 2
    for invalid in ("   ", "字" * 4001):
        with pytest.raises(WorkError):
            dsh_capture.prepare(db, "personal", uuid4(), invalid)
    assert calls == 2


def test_sensitive_raw_text_is_not_forwarded(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", TOKEN)
    configure(client, monkeypatch)
    calls = 0

    def fake(*_: object) -> object:
        nonlocal calls
        calls += 1
        raise RuntimeError("private provider response")

    monkeypatch.setattr(dsh_capture, "call_json", fake)
    db = engine(client)
    with pytest.raises(WorkError) as denied:
        dsh_capture.prepare(db, "personal", uuid4(), f"记录 {TOKEN}")
    assert TOKEN not in denied.value.message
    assert calls == 0
    with pytest.raises(RuntimeError, match="private provider response"):
        dsh_capture.prepare(db, "personal", uuid4(), "记录验收")
    assert calls == 1


def test_concurrent_same_operation_does_not_call_model_twice(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(client, monkeypatch)
    entered, release = Event(), Event()

    def fake(*_: object) -> object:
        assert not entered.is_set()
        entered.set()
        assert release.wait(10)
        return {"candidate": None}

    monkeypatch.setattr(dsh_capture, "call_json", fake)
    db, identifier = engine(client), uuid4()
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(dsh_capture.prepare, db, "personal", identifier, "记录验收")
        try:
            assert entered.wait(10)
            with pytest.raises(WorkError) as pending:
                dsh_capture.prepare(db, "personal", identifier, "记录验收")
            assert pending.value.status == 409
        finally:
            release.set()
        committed = first.result(timeout=10)
        assert dsh_capture.read(db, "personal", identifier) == committed


@pytest.mark.parametrize("case", ["new", "ambiguous", "forged", "no-owner"])
def test_candidate_boundaries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    configure(client, monkeypatch)
    goal, module, matter = tree(client)
    text = "采购模块的续约准备：和王月讨论续约材料，时间待定"
    draft_fields: dict[str, object] = {
        "title": "讨论续约材料",
        "evidence": text,
        "goal_id": goal,
        "module_id": module,
        "matter_id": matter,
        "reason": "按材料推荐",
        "owner": "王月",
        "planned_date": "2026-11-27",
    }
    if case == "new":
        draft_fields.update(
            module_id=None, matter_id=None, new_module_name="采购模块", new_matter_name="续约准备"
        )
    elif case == "ambiguous":
        other = client.post("/api/items", json={**payload("module", goal), "name": "其他"})
        assert other.status_code == 200
        duplicate = client.post(
            "/api/items", json={**payload("thing", other.json()["id"]), "name": "联调准备"}
        )
        assert duplicate.status_code == 200
    elif case == "forged":
        draft_fields["evidence"] = "未出现在原文中的资料"
    monkeypatch.setattr(dsh_capture, "call_json", lambda *_: {"candidate": draft_fields})
    db, identifier = engine(client), uuid4()
    if case == "forged":
        with pytest.raises(WorkError) as denied:
            dsh_capture.prepare(db, "personal", identifier, text)
        assert denied.value.status == 502
    else:
        result = dsh_capture.prepare(db, "personal", identifier, text)
        assert result.candidate is not None
        assert (
            result.candidate.path.kind
            == {"new": "new_module", "ambiguous": "unresolved", "no-owner": "existing"}[case]
        )
        assert result.candidate.owner is None and result.candidate.planned_date is None
    assert all(item["type"] != "event" for item in client.get("/api/items").json())


def test_migration_is_additive_and_explicit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "upgrade.db"))
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    config = Config("alembic.ini")
    command.upgrade(config, "0023")
    with TestClient(create_app(), base_url="http://127.0.0.1") as web:
        assert web.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        tree(web)
        before = web.get("/api/items").json()
        old_tables = set(inspect(engine(web)).get_table_names())
        assert "dsh_capture_drafts" not in old_tables
    command.upgrade(config, "0024")
    with TestClient(create_app(), base_url="http://127.0.0.1") as web:
        assert web.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        assert web.get("/api/items").json() == before
        assert set(inspect(engine(web)).get_table_names()) - old_tables == {"dsh_capture_drafts"}
