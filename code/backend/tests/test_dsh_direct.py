"""Exercise native approval, account isolation, and exact read-only recovery."""

import hmac
import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Connection, insert, select, update
from sqlalchemy.exc import OperationalError
from test_dsh_capture import TOKEN, call, engine, tree, value
from test_work import payload

from todo_backend.main import create_app
from todo_backend.modules import dsh_direct
from todo_backend.modules.work.repository import deletions, items, operations

_DIRECT = "host-approval-test-" + "y" * 32
_URL = "/api/dsh-direct/events"
_PATH = ["交付", "接口", "联调准备"]


@pytest.fixture
def enabled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "direct.db"))
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", TOKEN)
    monkeypatch.setenv("TODO_DSH_DIRECT_TOKEN", _DIRECT)
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 2000)) as web:
        assert web.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        yield web


def _body(thing: str, **overrides: object) -> dict[str, object]:
    return {
        "operation_id": str(uuid4()),
        "thing_id": thing,
        "expected_version": 1,
        "expected_path": _PATH,
        "title": "整理接口清单",
        **overrides,
    }


def _wire(body: dict[str, object]) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()


def _signature(body: bytes, secret: str = _DIRECT) -> str:
    return "v1=" + hmac.digest(secret.encode(), b"todo-direct-create-v1\n" + body, "sha256").hex()


def _post(client: TestClient, body: dict[str, object], **headers: str) -> Response:
    raw = _wire(body)
    return cast(
        Response,
        client.post(
            _URL,
            content=raw,
            headers={
                "Content-Type": "application/json",
                "X-Todo-Approval": _signature(raw),
                **headers,
            },
        ),
    )


def _lookup(client: TestClient, operation: object) -> dict[str, object]:
    return call(client, "get_recorded_event", {"operation_id": operation})


def test_auth_uses_exact_host_signature_and_does_not_accept_bearer_or_cookie(
    enabled: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, thing = tree(enabled)
    body = _body(thing)
    raw = _wire(body)
    unknown = _body(thing, title="修改后未经批准")
    with monkeypatch.context() as env:
        for invalid in ("", TOKEN, "short"):
            env.setenv("TODO_DSH_DIRECT_TOKEN", invalid)
            assert _post(enabled, body).status_code == 404
    # The fixture has a valid Web cookie. Neither that nor any bearer can authorize this write.
    assert enabled.post(_URL, json=body).status_code == 401
    for bearer in (TOKEN, _DIRECT):
        assert (
            enabled.post(_URL, json=body, headers={"Authorization": f"Bearer {bearer}"}).status_code
            == 401
        )
        assert _post(enabled, body, Authorization=f"Bearer {bearer}").status_code == 401
    assert _post(enabled, body, **{"X-Todo-Approval": _signature(raw, TOKEN)}).status_code == 401
    assert _post(enabled, unknown, **{"X-Todo-Approval": _signature(raw)}).status_code == 401
    assert (
        enabled.post(
            _URL,
            content=raw + b"\n",
            headers={"Content-Type": "application/json", "X-Todo-Approval": _signature(raw)},
        ).status_code
        == 401
    )
    for name, val in (
        ("Origin", "http://127.0.0.1"),
        ("Sec-Fetch-Mode", "cors"),
        ("Forwarded", "for=127.0.0.1"),
        ("X-Forwarded-Proto", "http"),
        ("X-Real-IP", "127.0.0.1"),
    ):
        assert _post(enabled, body, **{name: val}).status_code == 403
    assert _post(enabled, body, Host="not-local.example").status_code == 400
    with TestClient(
        create_app(), base_url="http://127.0.0.1", client=("192.0.2.5", 2000)
    ) as remote:
        assert _post(remote, body).status_code == 403
    assert _post(enabled, body, **{"Content-Type": "text/plain"}).status_code == 415
    oversized = b"x" * (64 * 1024 + 1)
    assert (
        enabled.post(
            _URL,
            content=oversized,
            headers={"Content-Type": "application/json", "X-Todo-Approval": _signature(oversized)},
        ).status_code
        == 413
    )
    assert (
        enabled.get(
            f"{_URL}/{body['operation_id']}", headers={"Authorization": f"Bearer {_DIRECT}"}
        ).status_code
        == 404
    )
    assert not any(item["type"] == "event" for item in enabled.get("/api/items").json())
    assert _lookup(enabled, body["operation_id"]).get("isError") is True


def test_record_replays_exact_snapshot_without_crossing_other_work_operations(
    enabled: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, thing = tree(enabled)
    operation = str(uuid4())
    body = _body(
        thing,
        operation_id=operation,
        owner="王月",
        planned_date="2026-11-27",
        description="核对范围",
    )
    result = _post(enabled, body)
    assert result.status_code == 200, result.text
    assert result.headers["Cache-Control"] == "no-store"
    receipt = result.json()
    event = receipt["event"]
    assert (
        event["parent"],
        event["name"],
        event["owner"],
        event["planEnd"],
        event["description"],
    ) == (thing, "整理接口清单", "王月", "2026-11-27", "核对范围")
    assert (event["type"], event["version"], event["status"]) == ("event", 1, "notStarted")
    with engine(enabled).connect() as conn:
        fingerprint = conn.scalar(
            select(operations.c.fingerprint).where(operations.c.id == operation)
        )
        assert isinstance(fingerprint, str) and fingerprint.startswith(dsh_direct.RECEIPT_PREFIX)
    assert value(_lookup(enabled, operation)) == receipt
    assert _post(enabled, body).json() == receipt
    assert _post(enabled, {**body, "title": "不同内容"}).status_code == 409
    assert enabled.get(f"/api/operations/{operation}").status_code == 404
    web_body = {**payload("event", thing), "operation_id": operation}
    assert enabled.post("/api/items", json=web_body).status_code == 409

    updated = enabled.put(
        f"/api/items/{event['id']}",
        json={
            **payload("event", thing),
            "expected_version": 1,
            "name": "后续独立编辑",
            "planEnd": event["planEnd"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert _post(enabled, body).json() == receipt
    assert value(_lookup(enabled, operation)) == receipt
    assert sum(item["type"] == "event" for item in enabled.get("/api/items").json()) == 1

    original_web = {**payload("event", thing), "name": "手工记录"}
    assert enabled.post("/api/items", json=original_web).status_code == 200
    other_op = original_web["operation_id"]
    missing = _lookup(enabled, str(uuid4()))
    assert _lookup(enabled, other_op) == missing and missing.get("isError") is True
    assert _post(enabled, _body(thing, operation_id=other_op)).status_code == 409
    assert enabled.get(f"/api/operations/{other_op}").json()["name"] == "手工记录"
    with monkeypatch.context() as other:
        other.setenv("TODO_OWNER_ID", "foreign-account")
        assert _lookup(enabled, operation) == missing
        assert _post(enabled, body).status_code == 409


def test_lookup_keeps_ambiguity_and_scope_without_writes(
    enabled: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    goal, _, first = tree(enabled)
    alternate = enabled.post("/api/items", json={**payload("module", goal), "name": "替代模块"})
    assert alternate.status_code == 200
    alt_id = alternate.json()["id"]
    second = enabled.post("/api/items", json={**payload("thing", alt_id), "name": "联调准备"})
    assert second.status_code == 200
    unrelated = enabled.post("/api/items", json={**payload("thing", alt_id), "name": first})
    assert unrelated.status_code == 200
    hidden = enabled.post(
        "/api/items",
        json={**payload("thing", alt_id), "name": "联调准备子项", "status": "completed"},
    )
    assert hidden.status_code == 200
    with monkeypatch.context() as other:
        other.setenv("TODO_OWNER_ID", "foreign-account")
        tree(enabled)
    db = engine(enabled)
    with db.connect() as conn:
        before = conn.execute(select(items)).all(), conn.execute(select(operations)).all()
    exact = value(call(enabled, "find_matters", {"query": first}))
    assert exact == {
        "matters": [{"thing_id": first, "version": 1, "path": _PATH}],
        "truncated": False,
    }
    ambiguous = value(call(enabled, "find_matters", {"query": "联调准备"}))
    names = cast(list[dict[str, object]], ambiguous["matters"])
    assert {m["thing_id"] for m in names} == {first, second.json()["id"]}
    assert {cast(list[str], m["path"])[1] for m in names} == {"接口", "替代模块"}
    assert value(call(enabled, "find_matters", {"query": "%"})) == {
        "matters": [],
        "truncated": False,
    }
    assert call(enabled, "find_matters", {"query": " "}).get("isError") is True
    with db.connect() as conn:
        assert before == (conn.execute(select(items)).all(), conn.execute(select(operations)).all())
    for index in range(11):
        inserted = enabled.post(
            "/api/items", json={**payload("thing", alt_id), "name": f"同名组 {index}"}
        )
        assert inserted.status_code == 200
    bounded = value(call(enabled, "find_matters", {"query": "同名组"}))
    assert bounded["truncated"] is True and len(cast(list[object], bounded["matters"])) == 10


@pytest.mark.parametrize(
    ("target", "change"),
    [
        ("goal", "cancelled"),
        ("module", "cancelled"),
        ("thing", "cancelled"),
        ("thing", "deleted"),
        ("goal", "renamed"),
        ("module", "renamed"),
        ("thing", "renamed"),
    ],
)
def test_requires_complete_active_chain_and_reviewed_path(
    enabled: TestClient, target: str, change: str
) -> None:
    goal, module, thing = tree(enabled)
    identifier = {"goal": goal, "module": module, "thing": thing}[target]
    body = _body(thing)
    with engine(enabled).begin() as conn:
        if change == "deleted":
            conn.execute(
                insert(deletions).values(
                    id=str(uuid4()),
                    account="personal",
                    item_id=identifier,
                    fingerprint="test",
                    result="{}",
                )
            )
        else:
            conn.execute(
                update(items)
                .where(items.c.id == identifier)
                .values(
                    **({"status": "cancelled"} if change == "cancelled" else {"name": "改了名称"})
                )
            )
    assert _post(enabled, body).status_code == 409
    assert _lookup(enabled, body["operation_id"]).get("isError") is True
    if change != "renamed":
        assert value(call(enabled, "find_matters", {"query": thing}))["matters"] == []
    # Legacy/inconsistent statuses are seeded directly to test the native guard.
    # The normal work API only accepts notStarted on goal/module rows.
    with engine(enabled).connect() as conn:
        assert conn.scalar(select(items.c.id).where(items.c.type == "event")) is None


def test_invalid_input_and_stale_version_do_not_claim_operation(enabled: TestClient) -> None:
    goal, _, thing = tree(enabled)
    body = _body(thing)
    for bad in (
        {"operation_id": "sensitive-bad-id"},
        {"owner": 4},
        {"title": " "},
        {"expected_version": True},
        {"expected_version": "1"},
        {"expected_path": ["交付", "接口"]},
        {"title": "敏感\u0000字符串"},
        {"planned_date": "2026-02-31"},
        {"new_thing_name": "不允许新建"},
    ):
        result = _post(enabled, {**body, **bad})
        assert result.status_code == 422, result.text
        assert "sensitive" not in result.text and "敏感" not in result.text
    assert _post(enabled, {**body, "expected_version": 2}).status_code == 409
    assert _post(enabled, {**body, "thing_id": goal}).status_code == 409
    assert _lookup(enabled, body["operation_id"]).get("isError") is True
    assert _post(enabled, body).status_code == 200


def test_atomic_rollback_and_unknown_result_only_read_original(
    enabled: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, thing = tree(enabled)
    original_lookup = dsh_direct._lookup
    body = _body(thing)

    def fail_insert(*args: object, **kwargs: object) -> object:
        raise OperationalError("INSERT", {}, RuntimeError("private adapter message"))

    with monkeypatch.context() as failure:
        failure.setattr(dsh_direct, "insert", fail_insert)
        result = _post(enabled, body)
    assert result.status_code == 503 and "private" not in result.text
    assert _lookup(enabled, body["operation_id"]).get("isError") is True
    assert not any(item["type"] == "event" for item in enabled.get("/api/items").json())

    lookup_calls = 0

    def lost_read(conn: Connection, account: str, operation_id: UUID) -> object:
        nonlocal lookup_calls
        lookup_calls += 1
        if lookup_calls == 2:
            raise OperationalError("SELECT", {}, RuntimeError("private content"))
        return original_lookup(conn, account, operation_id)

    with monkeypatch.context() as failure:
        failure.setattr(dsh_direct, "_lookup", lost_read)
        result = _post(enabled, body)
    assert result.status_code == 503 and "private" not in result.text
    assert value(_lookup(enabled, body["operation_id"]))["event"]
    assert sum(item["type"] == "event" for item in enabled.get("/api/items").json()) == 1


def test_concurrent_same_signature_does_not_duplicate_work(enabled: TestClient) -> None:
    _, _, thing = tree(enabled)
    body = _body(thing)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = (pool.submit(_post, enabled, body) for _ in range(2))
        responses = [first.result(timeout=10), second.result(timeout=10)]
    assert any(response.status_code == 200 for response in responses)
    assert all(response.status_code in (200, 409, 503) for response in responses)
    receipt = value(_lookup(enabled, body["operation_id"]))
    assert all(response.json() == receipt for response in responses if response.status_code == 200)
    assert sum(item["type"] == "event" for item in enabled.get("/api/items").json()) == 1
