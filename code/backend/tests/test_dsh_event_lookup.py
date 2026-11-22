"""Exercise bounded MCP event lookup without real model traffic or business writes."""

from collections.abc import Iterator
from pathlib import Path
from typing import cast
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from sqlalchemy import event, select, text
from sqlalchemy.engine import Engine
from test_dsh_capture import TOKEN, call, engine, rpc, value

from todo_backend.integrations.ai.embeddings import EmbeddingConfig, EmbeddingError
from todo_backend.main import create_app
from todo_backend.modules import dsh_event_lookup as lookup
from todo_backend.modules.memory.schemas import CardInput
from todo_backend.modules.memory.service import module_scope, save_card
from todo_backend.modules.work.repository import deletions, items, operations
from todo_backend.modules.work.schemas import ItemOutput, WriteInput
from todo_backend.modules.work.service import write_item


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Mount an opted-in lookup tool against a disposable database."""
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "lookup.db"))
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    monkeypatch.setenv("TODO_DSH_CAPTURE_TOKEN", TOKEN)
    monkeypatch.setenv("TODO_DSH_EVENT_LOOKUP", "1")
    monkeypatch.setenv("TODO_DSH_EVENT_EMBEDDING_CONSENT", "0")
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "1")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 2000)) as c:
        yield c


def create(
    db: Engine, kind: str, name: str, parent: str | None = None, **kwargs: str
) -> ItemOutput:
    """Create synthetic work items using the normal business service."""
    return write_item(
        db,
        "personal",
        WriteInput.model_validate(
            {
                "type": kind,
                "name": name,
                "parent": parent,
                "operation_id": uuid4(),
                **kwargs,
            }
        ),
    )


def chain(db: Engine, suffix: str = "") -> tuple[ItemOutput, ItemOutput, ItemOutput]:
    """Build a current goal, module and matter for one test."""
    goal = create(db, "goal", "交付" + suffix)
    module = create(db, "module", "采购协同" + suffix, goal.id)
    matter = create(db, "thing", "首批物料" + suffix, module.id)
    return goal, module, matter


def card(db: Engine, mid: str, alias: str) -> None:
    """Confirm synthetic module memory through its service."""
    with db.connect() as conn:
        _, scope = module_scope(conn, "personal", mid)
    save_card(
        db,
        "personal",
        mid,
        CardInput(
            operation_id=uuid4(),
            expected_version=0,
            scope_version=scope,
            description="合成采购模块职责",
            aliases=[alias],
        ),
    )


def query(client: TestClient, content: str, hint: str = "") -> lookup.EventLookup:
    """Read and validate the actual MCP output."""
    return lookup.EventLookup.model_validate(
        value(
            call(
                client,
                "locate_event",
                {
                    "content": content,
                    "scope_hint": hint,
                },
            )
        )
    )


def test_discovery_auth_and_read_only_result(client: TestClient) -> None:
    _, mod, matter = chain(engine(client))
    target = create(engine(client), "event", "核对采购报价", matter.id, description="不要返回正文")
    card(engine(client), mod.id, "老王对接")
    assert {t["name"] for t in rpc(client, "tools/list", {}).json()["result"]["tools"]} == {
        "find_matters",
        "get_recorded_event",
        "get_event_to_complete",
        "locate_event",
    }
    assert rpc(client, "tools/call", {}, Authorization="").status_code == 401
    with engine(client).connect() as conn:
        before = conn.execute(select(operations)).all(), conn.execute(select(items)).all()
    result = query(client, "老王对接那边价格已经谈妥，帮我标完成")
    assert result.status == "candidates" and result.scope_method == "module_memory"
    assert [item.event_id for item in result.events] == [target.id]
    assert result.events[0].version == target.version
    assert result.events[0].path == ("交付", "采购协同", "首批物料")
    assert "不要返回正文" not in result.model_dump_json()
    assert call(client, "event_completion", {"event_id": target.id}).get("isError") is True
    with engine(client).connect() as conn:
        assert before == (conn.execute(select(operations)).all(), conn.execute(select(items)).all())


def test_scope_is_not_widened_on_miss_or_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = engine(client)
    _, mod, matter = chain(db)
    card(db, mod.id, "合成采购")
    create(db, "event", "不应被查到", matter.id)
    monkeypatch.setenv("TODO_EMBEDDING_SOURCE_CONSENT", "1")

    def unexpected(*args: object) -> None:
        pytest.fail("unresolved scope must not query events or call an external provider")

    monkeypatch.setattr(lookup, "embed", unexpected)
    monkeypatch.setattr(lookup, "_candidates", unexpected)
    assert query(client, "价格定了", "不存在的事情").status == "no_scope"
    no_consent = query(client, "价格定了")
    assert no_consent.status == "unavailable" and "未授权" in no_consent.message
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "0")
    assert "未启用" in query(client, "价格定了").message


def test_explicit_scope_filters_other_matter_account_deleted_and_closed(client: TestClient) -> None:
    db = engine(client)
    _, mod, matter = chain(db)
    another = create(db, "thing", "二次补货", mod.id)
    good = create(db, "event", "当前事件", matter.id)
    create(db, "event", "另一事情的事件", another.id)
    create(db, "event", "已完成事件", matter.id, status="completed")
    deleted = create(db, "event", "已删除事件", matter.id)
    old = create(db, "event", "错误账号事件", matter.id)
    with db.begin() as conn:
        conn.execute(
            deletions.insert().values(
                id=str(uuid4()),
                account="personal",
                item_id=deleted.id,
                fingerprint="synthetic",
                result="{}",
            )
        )
        conn.execute(items.update().where(items.c.id == old.id).values(account="foreign"))
    result = query(client, "联系对方后完成了", "交付 / 采购协同 / 首批物料")
    assert result.status == "candidates" and result.scope_method == "explicit"
    assert [item.event_id for item in result.events] == [good.id]
    quiet = create(db, "thing", "没有事件", mod.id)
    assert query(client, "价格定了", quiet.name).status == "no_events"


def test_limits_and_deterministic_order(client: TestClient) -> None:
    db = engine(client)
    goal, mod, matter = chain(db)
    for index in range(11):
        create(db, "event", f"模拟{index:02}", matter.id)
    result = query(client, "价格定了", mod.name)
    assert result.truncated and [item.title for item in result.events] == [
        f"模拟{index:02}" for index in range(10)
    ]
    assert len(result.model_dump_json().encode()) <= lookup.RESPONSE_BYTES
    for number in range(3):
        create(db, "module", f"补充模块{number}", goal.id)
    result = query(client, "价格定了", goal.name)
    assert result.status == "scope_ambiguous" and not result.events


def test_validation_and_runtime_off_switch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert call(client, "locate_event", {"content": "x" * 1001}).get("isError") is True
    marked = call(client, "locate_event", {"content": "密码：example-value"})
    assert marked.get("isError") is True and "example-value" not in str(marked)
    monkeypatch.setenv("TODO_DSH_EVENT_LOOKUP", "0")
    assert query(client, "价格定了").status == "unavailable"
    with TestClient(create_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 2000)) as new:
        assert {t["name"] for t in rpc(new, "tools/list", {}).json()["result"]["tools"]} == {
            "find_matters",
            "get_recorded_event",
            "get_event_to_complete",
        }


def test_vector_path_requires_profile_and_distance_and_preserves_scope(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = engine(client)
    if db.dialect.name != "postgresql":
        pytest.skip("Native pgvector needs an explicitly isolated PostgreSQL database")
    config = EmbeddingConfig("https://example.test/embeddings", "test", 3, "synthetic", "v1")
    monkeypatch.setattr(lookup, "configuration", lambda: config)
    monkeypatch.setenv("TODO_DSH_EVENT_EMBEDDING_CONSENT", "1")
    monkeypatch.setenv("TODO_DSH_EVENT_VECTOR_CALIBRATION", "wrong-profile:0.25")
    targets = [chain(db, str(index)) for index in range(4)]
    for index, (_, mod, matter) in enumerate(targets):
        card(db, mod.id, f"简称{index}")
        create(db, "event", f"合成事件{index}", matter.id)
    statements: list[str] = []
    event.listen(db, "before_cursor_execute", lambda *_args: statements.append(cast(str, _args[2])))
    calls: list[str] = []

    def fake_embed(content: str, _config: EmbeddingConfig) -> list[float]:
        calls.append(content)
        return [1.0, 0.0, 0.0]

    monkeypatch.setattr(lookup, "embed", fake_embed)
    assert query(client, "供应商价格谈妥了").status == "unavailable" and not calls
    monkeypatch.setenv("TODO_DSH_EVENT_VECTOR_CALIBRATION", f"{config.profile}:0.25")
    assert query(client, "供应商价格谈妥了").status == "unavailable" and not calls
    with db.begin() as conn:
        for index, (_, mod, _) in enumerate(targets):
            conn.execute(
                text(
                    "INSERT INTO memory_vectors VALUES (:a, :m, :r, :p, CAST(:v AS public.vector))"
                ),
                {
                    "a": "personal" if index != 3 else "foreign",
                    "m": mod.id,
                    "r": 99 if index == 2 else 1,
                    "p": config.profile if index != 1 else "old-profile",
                    "v": "[0,1,0]" if index == 0 else "[1,0]" if index == 1 else "[1,0,0]",
                },
            )
    assert query(client, "供应商价格谈妥了").status == "no_scope"
    assert calls == ["供应商价格谈妥了"] and not any("lookup_event" in s for s in statements)
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE memory_vectors SET embedding='[1,0,0]'::public.vector "
                "WHERE module_id=:m AND account='personal'"
            ),
            {"m": targets[0][1].id},
        )
    found = query(client, "供应商价格谈妥了")
    assert found.scope_method == "vector_memory" and [item.title for item in found.events] == [
        "合成事件0"
    ]

    def unavailable(_content: str, _config: EmbeddingConfig) -> list[float]:
        raise EmbeddingError("provider down")

    monkeypatch.setattr(lookup, "embed", unavailable)
    statements.clear()
    assert query(client, "供应商价格谈妥了").status == "unavailable"
    assert not any("lookup_event" in s for s in statements)
