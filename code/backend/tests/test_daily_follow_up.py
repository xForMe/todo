"""Observable follow-up persistence, date grounding, isolation and atomic failure paths."""

from datetime import date, datetime
from typing import cast
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Table, insert, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql.dml import Insert
from test_daily_review import action
from test_work import client as client_fixture

from todo_backend.integrations.ai.client import AIError
from todo_backend.integrations.ai.follow_up import Decision, grounded_date
from todo_backend.modules.work import daily_follow_up as service
from todo_backend.modules.work.repository import deletions, items

client = client_fixture
TEXT = "今天数据没拿到，完成时间改到11月25日。"


@pytest.fixture(autouse=True)
def fake_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep this suite offline and freeze the explicit Beijing business date."""

    def clock() -> datetime:
        return datetime.fromisoformat("2026-11-18T10:00:00+08:00")

    monkeypatch.setattr(service, "beijing_now", clock)
    monkeypatch.setattr("todo_backend.modules.work.workbench.beijing_now", clock)
    monkeypatch.setattr(service, "recognize_follow_up", lambda *_: Decision(kind="none"))


def planned(client: TestClient) -> dict[str, object]:
    """Create a synthetic event and a plan using the existing public contract."""
    item = action(client)
    data = {k: v for k, v in item.items() if k not in ("id", "version")}
    data.update(
        operation_id=str(uuid4()), expected_version=1, planStart="2026-11-18", planEnd="2026-11-20"
    )
    response = client.put(f"/api/items/{item['id']}", json=data)
    assert response.status_code == 200, response.text
    return cast(dict[str, object], response.json())


def command(client: TestClient, item_id: str, text: str = TEXT) -> dict[str, object]:
    """Use the displayed item/day/revision to create a fresh explicit command."""
    view = client.get(f"/api/items/{item_id}/daily-follow-ups").json()
    return dict(
        operation_id=str(uuid4()),
        expected_version=view["item"]["version"],
        expected_revision=view["revision"],
        day=view["day"],
        content=text,
    )


def delay(item_id: str, **changes: str) -> Decision:
    """A grounded model response for the synthetic current action."""
    return Decision.model_validate(
        dict(
            kind="delay",
            target_id=item_id,
            end="2026-11-25",
            evidence=TEXT,
            date_text="11月25日",
            reason="今天数据没拿到",
        )
        | changes
    )


def test_append_replay_and_atomic_delay(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = planned(client)
    item_id = str(item["id"])
    url = f"/api/items/{item_id}/daily-follow-ups"
    before_history = client.get(f"/api/items/{item_id}/plan-history").json()
    calls = []

    def recognize(*_: str) -> Decision:
        calls.append(1)
        return delay(item_id)

    monkeypatch.setattr(service, "recognize_follow_up", recognize)
    data = command(client, item_id)
    saved = client.post(url, json=data)
    assert saved.status_code == 200, saved.text
    result = saved.json()
    assert client.post(url, json=data).json() == result
    assert len(calls) == 1
    assert (
        client.get("/api/daily-follow-up-operations/" + str(data["operation_id"])).json() == result
    )
    assert client.post(url, json={**data, "content": "其他内容"}).status_code == 409
    view = client.get(url).json()
    assert view["records"] == [result]
    assert view["item"]["planEnd"] == "2026-11-25"
    assert view["item"]["planStart"] == item["planStart"]
    assert view["item"]["status"] == item["status"]
    history = client.get(f"/api/items/{item_id}/plan-history").json()
    assert len(history["records"]) == len(before_history["records"]) + 1
    assert history["records"][0]["operation_id"] == result["id"]
    assert history["records"][0]["reason"] == "今天数据没拿到"
    second = client.post(url, json=command(client, item_id))
    assert second.status_code == 200
    assert len(client.get(url).json()["records"]) == 2
    assert len(client.get(f"/api/items/{item_id}/plan-history").json()["records"]) == len(
        history["records"]
    )
    assert len(client.get("/api/workbench").json()["daily_reviews"]) == 1
    latest = client.get(url).json()
    assert (
        client.post(
            f"/api/items/{item_id}/daily-review",
            json={
                "operation_id": str(uuid4()),
                "expected_version": latest["item"]["version"],
                "expected_revision": latest["revision"],
                "day": latest["day"],
                "reviewed": False,
            },
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "change",
    [
        {"target_id": "other"},
        {"end": "2026-11-26"},
        {"date_text": "11月26日"},
        {"reason": "编造原因"},
        {"evidence": "虚构延期"},
        {"kind": "other"},
        {"kind": "unclear"},
    ],
)
def test_ungrounded_decision_does_not_change_dates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, change: dict[str, str]
) -> None:
    item = planned(client)
    item_id = str(item["id"])
    monkeypatch.setattr(service, "recognize_follow_up", lambda *_: delay(item_id, **change))
    url = f"/api/items/{item_id}/daily-follow-ups"
    result = client.post(url, json=command(client, item_id))
    assert result.status_code == 200
    assert result.json()["new_end"] == "2026-11-20"
    assert client.get(url).json()["item"]["planEnd"] == "2026-11-20"


def test_failures_scope_and_versions(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    item = planned(client)
    item_id = str(item["id"])
    url = f"/api/items/{item_id}/daily-follow-ups"
    data = command(client, item_id)
    assert client.post(url, json={**data, "content": "  "}).status_code == 422
    assert client.post(url, json={**data, "expected_version": 99}).status_code == 409
    assert client.post(url, json={**data, "expected_revision": 99}).status_code == 409
    assert client.post(url, json={**data, "day": "2026-11-17"}).status_code == 409
    assert client.post(url, json=data, headers={"Origin": "https://example.com"}).status_code == 403
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.post(url, json=data).status_code == 404
    assert client.get(url).status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "personal")

    def fail(*_: str) -> Decision:
        raise AIError("synthetic")

    monkeypatch.setattr(service, "recognize_follow_up", fail)
    assert client.post(url, json=data).status_code == 502
    assert client.get(url).json()["records"] == []
    saved = client.post(url, json={**data, "skip_ai": True})
    assert saved.status_code == 200
    assert "尚未识别" in saved.json()["note"]
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert (
        client.get("/api/daily-follow-up-operations/" + str(data["operation_id"])).status_code
        == 404
    )


def test_mid_recognition_change_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = planned(client)
    item_id = str(item["id"])
    engine = cast(FastAPI, client.app).state.engine

    def mutate(*_: str) -> Decision:
        with engine.begin() as conn:
            conn.execute(items.update().where(items.c.id == item_id).values(version=3))
        return delay(item_id)

    monkeypatch.setattr(service, "recognize_follow_up", mutate)
    url = f"/api/items/{item_id}/daily-follow-ups"
    assert client.post(url, json=command(client, item_id)).status_code == 409
    assert client.get(url).json()["records"] == []


def test_rollback_and_lost_readback(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    item = planned(client)
    item_id = str(item["id"])
    monkeypatch.setattr(service, "recognize_follow_up", lambda *_: delay(item_id))
    url = f"/api/items/{item_id}/daily-follow-ups"
    data = command(client, item_id)
    history = client.get(f"/api/items/{item_id}/plan-history").json()["records"]

    def fail(table: Table) -> Insert:
        if table is service.followups:
            raise OperationalError("test", {}, Exception("injected"))
        return insert(table)

    monkeypatch.setattr(service, "insert", fail)
    assert client.post(url, json=data).status_code == 503
    assert client.get(url).json()["records"] == []
    assert client.get(url).json()["item"]["planEnd"] == "2026-11-20"
    assert client.get(f"/api/items/{item_id}/plan-history").json()["records"] == history
    monkeypatch.setattr(service, "insert", insert)
    original = service.receipt

    def lost(*_: object) -> service.FollowOutput:
        raise OperationalError("test", {}, Exception("readback lost"))

    monkeypatch.setattr(service, "receipt", lost)
    assert client.post(url, json=data).status_code == 503
    monkeypatch.setattr(service, "receipt", original)
    assert (
        client.get("/api/daily-follow-up-operations/" + str(data["operation_id"])).status_code
        == 200
    )
    assert len(client.get(url).json()["records"]) == 1
    assert client.post(url, json=data).status_code == 200


def test_ended_deleted_and_cross_day(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    item = planned(client)
    item_id = str(item["id"])
    url = f"/api/items/{item_id}/daily-follow-ups"
    data = command(client, item_id)
    assert client.post(url, json=data).status_code == 200
    monkeypatch.setattr(
        service, "beijing_now", lambda: datetime.fromisoformat("2026-11-19T00:00:01+08:00")
    )
    assert client.get(url).json()["records"] == []
    assert client.post(url, json={**data, "operation_id": str(uuid4())}).status_code == 409
    assert client.post(url, json=data).status_code == 200
    engine = cast(FastAPI, client.app).state.engine
    with engine.begin() as conn:
        assert len(conn.execute(select(service.followups)).all()) == 1
        conn.execute(items.update().where(items.c.id == item_id).values(status="completed"))
    assert client.post(url, json=command(client, item_id)).status_code == 409
    with engine.begin() as conn:
        conn.execute(
            insert(deletions).values(
                id=str(uuid4()),
                account="personal",
                item_id=item_id,
                fingerprint="test",
                result="{}",
            )
        )
    assert client.get(url).status_code == 404
    assert client.post(url, json=data).status_code == 404


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("11月25日", "2026-11-25"),
        ("2026-11-25", "2026-11-25"),
        ("明天", "2026-11-19"),
        ("下周三", "2026-11-25"),
        ("推迟3天", "2026-11-23"),
        ("晚几天", ""),
        ("11月31日", ""),
        ("2026-02-29", ""),
    ],
)
def test_date_grounding(phrase: str, expected: str) -> None:
    assert grounded_date(phrase, date(2026, 11, 18), "2026-11-20") == expected
