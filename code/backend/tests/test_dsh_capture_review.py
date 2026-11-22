"""Exercise explicit Web capture approval with synthetic drafts and isolated SQLite."""

import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Connection, insert, inspect, select, update
from sqlalchemy.exc import OperationalError
from test_dsh_capture import HEADERS, engine, tree
from test_work import payload

from todo_backend.main import create_app
from todo_backend.modules import dsh_capture, dsh_capture_review
from todo_backend.modules.dsh_capture_review import ConfirmationInput
from todo_backend.modules.sources.placement import create_work
from todo_backend.modules.work import plan_history
from todo_backend.modules.work.repository import items, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError

WEB = {"Origin": "http://127.0.0.1", "X-Todo-Client": "web", "Sec-Fetch-Site": "same-origin"}
ROOT = "/api/dsh-captures"
SOURCE = "整理验收清单，负责人：小王"


@pytest.fixture
def web(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", "sqlite:///" + (tmp_path / "review.db").as_posix())
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url=WEB["Origin"], client=("127.0.0.1", 2000)) as client:
        assert client.get("/api/session", headers={"X-Todo-Client": "web"}).status_code == 200
        yield client


def draft(web: TestClient, account: str = "personal", kind: str = "candidate") -> str:
    identifier = str(uuid4())
    candidate = dsh_capture.Candidate(
        title="旧标题",
        owner=None,
        planned_date=None,
        reason="原文无法确认归属",
        path=dsh_capture.CapturePath(kind="unresolved"),
        evidence=SOURCE,
    )
    with engine(web).begin() as conn:
        conn.execute(
            insert(dsh_capture.drafts).values(
                account=account,
                operation_id=identifier,
                fingerprint="a" * 64,
                claim_until=0,
                revision=0 if kind == "in_progress" else 1,
                candidate=candidate.model_dump_json() if kind == "candidate" else None,
            )
        )
    return identifier


def confirmation(
    chain: tuple[str, str, str], *, new_module: str = "", new_thing: str = ""
) -> ConfirmationInput:
    goal, module, thing = chain
    return ConfirmationInput.model_validate(
        {
            "operation_id": str(uuid4()),
            "expected_revision": 1,
            "title": "整理验收清单",
            "owner": "小王",
            "planned_date": "2026-11-27",
            "placement": {
                "goal_id": goal,
                "module_id": "" if new_module else module,
                "thing_id": "" if new_thing else thing,
                "new_module_name": new_module,
                "new_thing_name": new_thing,
                "versions": {identifier: 1 for identifier in (goal, module, thing) if identifier},
            },
        }
    )


def post(web: TestClient, capture: str, data: ConfirmationInput) -> Response:
    return cast(
        Response,
        web.post(f"{ROOT}/{capture}/confirm", json=data.model_dump(mode="json"), headers=WEB),
    )


def lookup(web: TestClient, capture: str, data: ConfirmationInput) -> Response:
    return cast(Response, web.get(f"{ROOT}/{capture}/operations/{data.operation_id}"))


def test_pending_page_and_browser_auth(web: TestClient) -> None:
    pending = sorted(draft(web) for _ in range(3))
    assert web.get(f"{ROOT}/{draft(web, kind='none')}").json()["candidate"] is None
    draft(web, kind="in_progress")
    foreign = draft(web, account="foreign")
    assert web.get(f"{ROOT}/{foreign}").status_code == 404
    assert web.get(f"{ROOT}?offset=-1").status_code == 422
    assert web.get(f"{ROOT}?limit=51").status_code == 422
    first = web.get(f"{ROOT}?offset=0&limit=2")
    second = web.get(f"{ROOT}?offset=2&limit=2")
    assert first.headers["cache-control"] == "no-store"
    assert first.json()["total"] == second.json()["total"] == 3
    assert [row["operation_id"] for row in first.json()["drafts"] + second.json()["drafts"]] == (
        pending
    )
    assert web.get(f"{ROOT}?offset=3").json() == {"drafts": [], "total": 3}
    data = confirmation(tree(web))
    path = f"{ROOT}/{pending[0]}/confirm"
    body = data.model_dump(mode="json")
    for headers in (
        {},
        {"X-Todo-Client": "web"},
        {"Origin": WEB["Origin"]},
        {**WEB, "Origin": "http://localhost"},
        {**WEB, "Origin": "http://127.0.0.1:8000"},
        {**WEB, "Sec-Fetch-Site": "same-site"},
        {**WEB, "Sec-Fetch-Site": "cross-site"},
        {**WEB, "X-Todo-Client": "not-web"},
        {**WEB, **HEADERS},
    ):
        assert web.post(path, json=body, headers=headers).status_code == 403
    assert (
        web.post(
            path, json=body, headers=[*WEB.items(), ("Origin", "http://localhost")]
        ).status_code
        == 403
    )
    assert post(web, foreign, data).status_code == 404
    assert lookup(web, pending[0], data).status_code == 404
    web.cookies.clear()
    assert web.get(ROOT, headers=HEADERS).status_code == 401
    assert web.post(path, json=body, headers=WEB).status_code == 401


@pytest.mark.parametrize("new_module,new_thing", [("", ""), ("", "新事情"), ("新模块", "新事情")])
def test_accept_creates_only_chosen_nodes_and_exact_receipt(
    web: TestClient, new_module: str, new_thing: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    goal, module, thing = tree(web)
    capture, other = draft(web), draft(web)
    data = confirmation(
        (goal, "" if new_module else module, "" if new_thing else thing),
        new_module=new_module,
        new_thing=new_thing,
    )
    seen: list[ItemOutput | None] = []

    def observe(conn: Connection, account: str, identifier: str) -> ItemOutput | None:
        result = read_item(conn, account, identifier)
        with engine(web).connect() as independent:
            seen.append(read_item(independent, account, identifier))
        return result

    monkeypatch.setattr(dsh_capture_review, "read_item", observe)
    result = post(web, capture, data)
    assert result.status_code == 200, result.text
    event = result.json()["event"]
    assert seen[0] is None and seen[1] is not None
    assert result.headers["cache-control"] == "no-store"
    assert (event["name"], event["owner"], event["planEnd"], event["description"]) == (
        data.title,
        data.owner,
        data.planned_date,
        SOURCE,
    )
    with engine(web).connect() as conn:
        nodes = conn.execute(select(items)).mappings().all()
        assert len(nodes) == 4 + bool(new_module) + bool(new_thing)
        stored_thing = next(row for row in nodes if row["id"] == event["parent"])
        assert stored_thing["name"] == (new_thing or "联调准备")
        stored_module = next(row for row in nodes if row["id"] == stored_thing["parent"])
        assert stored_module["name"] == (new_module or "接口") and stored_module["parent"] == goal
        assert conn.execute(
            select(plan_history.baselines).where(plan_history.baselines.c.item_id == event["id"])
        ).one()
    assert [row["operation_id"] for row in web.get(ROOT).json()["drafts"]] == [other]
    assert web.get(f"{ROOT}/{capture}").json()["candidate"]["title"] == "旧标题"
    assert lookup(web, other, data).status_code == 404
    assert post(web, other, data).status_code == 409
    assert post(web, capture, data.model_copy(update={"title": "不同标题"})).status_code == 409
    fresh = data.model_copy(update={"operation_id": uuid4()})
    assert post(web, capture, fresh).status_code == 409
    assert lookup(web, capture, fresh).status_code == 404
    with monkeypatch.context() as foreign:
        foreign.setenv("TODO_OWNER_ID", "foreign")
        assert lookup(web, capture, data).status_code == 404
    with engine(web).begin() as conn:
        conn.execute(
            update(items).where(items.c.id == event["id"]).values(name="已编辑", version=2)
        )
    assert lookup(web, capture, data).json() == result.json()
    assert post(web, capture, data).json() == result.json()
    assert len(seen) == 2  # Exact replay reads the receipt, not later event edits.


@pytest.mark.parametrize(
    "failure", ["stale-draft", "stale-work", "closed", "wrong-goal", "foreign"]
)
def test_reject_changed_or_out_of_scope_hierarchy(web: TestClient, failure: str) -> None:
    goal, module, thing = tree(web)
    capture = draft(web)
    data = confirmation((goal, module, thing))
    with engine(web).begin() as conn:
        if failure == "stale-draft":
            conn.execute(update(dsh_capture.drafts).values(revision=2))
        if failure == "stale-work":
            conn.execute(update(items).where(items.c.id == module).values(version=2))
        if failure == "closed":
            conn.execute(update(items).where(items.c.id == thing).values(status="completed"))
        if failure == "foreign":
            conn.execute(update(items).where(items.c.id == goal).values(account="foreign"))
    if failure == "wrong-goal":
        result = web.post("/api/items", json=payload("goal"))
        assert result.status_code == 200
        data = confirmation((result.json()["id"], module, thing))
    assert post(web, capture, data).status_code == 409
    assert lookup(web, capture, data).status_code == 404
    assert web.get(ROOT).json()["total"] == 1
    with engine(web).connect() as conn:
        assert not conn.execute(select(items.c.id).where(items.c.type == "event")).all()


def test_invalid_shape_and_duplicate_names_never_write(web: TestClient) -> None:
    goal, module, thing = tree(web)
    capture = draft(web)
    valid = confirmation((goal, module, thing)).model_dump(mode="json")
    for patch in (
        {"planned_date": "2026-02-29"},
        {"expected_revision": "1"},
        {"title": " "},
        {"placement": {**valid["placement"], "versions": {goal: 1, module: 1}}},
        {"placement": {**valid["placement"], "new_thing_name": "重复选择"}},
    ):
        assert (
            web.post(f"{ROOT}/{capture}/confirm", json={**valid, **patch}, headers=WEB).status_code
            == 422
        )
    duplicate = confirmation((goal, module, ""), new_thing="联调准备")
    assert post(web, capture, duplicate).status_code == 409
    assert lookup(web, capture, duplicate).status_code == 404


def test_failed_insert_rolls_back_and_unknown_readback_only_recovers(
    web: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    goal, _, _ = tree(web)
    capture = draft(web)
    data = confirmation((goal, "", ""), new_module="新模块", new_thing="新事情")

    def fail(conn: Connection, account: str, item: ItemInput) -> str:
        create_work(conn, account, item)
        raise OperationalError("unsafe SQL detail", None, Exception("test failure"))

    with monkeypatch.context() as failure:
        failure.setattr(dsh_capture_review, "create_work", fail)
        response = post(web, capture, data)
        assert response.status_code == 503 and "unsafe SQL detail" not in response.text
        assert lookup(web, capture, data).status_code == 404
        assert web.get(ROOT).json()["total"] == 1
        with engine(web).connect() as conn:
            assert len(conn.execute(select(items.c.id)).all()) == 3

    reads = 0

    def lost_readback(conn: Connection, account: str, identifier: str) -> ItemOutput | None:
        nonlocal reads
        reads += 1
        return read_item(conn, account, identifier) if reads == 1 else None

    monkeypatch.setattr(dsh_capture_review, "read_item", lost_readback)
    assert post(web, capture, data).status_code == 503 and reads == 2
    assert web.get(ROOT).json()["total"] == 0
    reply = lookup(web, capture, data)
    assert reply.status_code == 200 and reply.json()["event"]["name"] == data.title
    assert reads == 2
    with engine(web).begin() as conn:
        assert len(conn.execute(select(items.c.id)).all()) == 6
        event = reply.json()["event"]
        del event["owner"]  # ItemOutput has a default, but receipts must be complete.
        conn.execute(
            update(dsh_capture_review.confirmations).values(result=json.dumps({"event": event}))
        )
    assert lookup(web, capture, data).status_code == 503
    assert post(web, capture, data).status_code == 503


@pytest.mark.parametrize("same_capture", [True, False])
def test_duplicate_concurrent_approvals_reserve_capture_and_operation(
    web: TestClient, same_capture: bool
) -> None:
    first = draft(web)
    second = first if same_capture else draft(web)
    data = confirmation(tree(web))
    competing = data.model_copy(update={"operation_id": uuid4()}) if same_capture else data
    db = engine(web)

    def attempt(capture: str, body: ConfirmationInput) -> int:
        try:
            dsh_capture_review.confirm(db, "personal", UUID(capture), body)
        except WorkError as exc:
            return exc.status
        return 200

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = [pool.submit(attempt, first, data), pool.submit(attempt, second, competing)]
        assert sorted(task.result(timeout=10) for task in statuses) == [200, 409]
    with db.connect() as conn:
        assert len(conn.execute(select(items.c.id).where(items.c.type == "event")).all()) == 1
        assert conn.execute(select(dsh_capture_review.confirmations.c.operation_id)).one()


def test_0025_is_additive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", "sqlite:///" + (tmp_path / "upgrade.db").as_posix())
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    command.upgrade(Config("alembic.ini"), "0024")
    with TestClient(create_app(), base_url=WEB["Origin"]) as web:
        web.get("/api/session", headers={"X-Todo-Client": "web"})
        capture = draft(web)
        before_tables = set(inspect(engine(web)).get_table_names())
        before = web.get(f"{ROOT}/{capture}").json()
        command.upgrade(Config("alembic.ini"), "0025")
        assert set(inspect(engine(web)).get_table_names()) - before_tables == {
            "dsh_capture_confirmations"
        }
        assert web.get(f"{ROOT}/{capture}").json() == before
        assert web.get(ROOT).json() == {"drafts": [before], "total": 1}
