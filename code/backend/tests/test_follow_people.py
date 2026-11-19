"""Offline identity search boundaries for REQ-O-010."""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient

from todo_backend.integrations.feishu_cli import contacts
from todo_backend.integrations.feishu_cli.reader import ReadFailure
from todo_backend.main import create_app


def test_people_projection_and_exact_saved_id(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    payload = {
        "ok": True,
        "data": {
            "has_more": True,
            "users": [
                {
                    "open_id": "ou_one",
                    "localized_name": "张三",
                    "department": "研发",
                    "email": "private",
                },
                {"open_id": "ou_two", "localized_name": "张三", "department": "交付"},
                {"open_id": "ou_hidden", "localized_name": "ou_hidden"},
            ],
        },
    }

    def fake(args: list[str]) -> bytes:
        calls.append(args)
        return json.dumps(payload).encode()

    monkeypatch.setattr(contacts, "run_read_command", fake)
    result = contacts.search_people("张三")
    assert result["has_more"] is True
    assert isinstance(result["people"], list)
    assert len(result["people"]) == 2
    assert "private" not in str(result)
    assert calls[0][-2:] == ["--query", "张三"]
    result = contacts.search_people("", "ou_two")
    assert result["people"] == [
        {"id": "ou_two", "name": "张三", "department": "交付", "enterprise_email": ""}
    ]
    assert calls[-1][-2:] == ["--user-ids", "ou_two"]


@pytest.mark.parametrize(
    "payload", [b"not-json", b'{"ok":false}', b'{"ok":true,"data":{"users":[{}]}}']
)
def test_people_invalid_response(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    monkeypatch.setattr(contacts, "run_read_command", lambda args: payload)
    with pytest.raises(ReadFailure):
        contacts.search_people("张三")


def test_people_event_scope_and_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "people.db"))
    command.upgrade(Config("alembic.ini"), "head")
    calls = []

    def fake(query: str, recipient: str = "") -> dict[str, object]:
        calls.append((query, recipient))
        if query == "失败":
            raise ReadFailure("secret upstream data")
        return {"people": [], "has_more": False}

    monkeypatch.setattr("todo_backend.modules.sources.people.search_people", fake)
    with TestClient(create_app(), base_url="http://127.0.0.1") as client:
        endpoint = "/api/sources/follow-people"
        assert client.get(endpoint, params={"event_id": "x", "query": "张三"}).status_code == 401
        client.get("/api/session", headers={"X-Todo-Client": "web"})
        parent = None
        for kind in ("goal", "module", "thing", "event"):
            r = client.post(
                "/api/items",
                json={"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": kind},
            )
            assert r.status_code == 200
            parent = r.json()["id"]
        assert (
            client.get(endpoint, params={"event_id": "missing", "query": "张三"}).status_code == 404
        )
        assert not calls
        for query in ("", "a" * 51):
            assert (
                client.get(endpoint, params={"event_id": parent, "query": query}).status_code == 422
            )
        assert (
            client.get(endpoint, params={"event_id": parent, "query": "张三"}).json()["people"]
            == []
        )
        r = client.get(endpoint, params={"event_id": parent, "query": "失败"})
        assert r.status_code == 503 and "secret" not in r.text
        before = len(calls)
        assert (
            client.get(endpoint, params={"event_id": parent, "saved": True}).json()["people"] == []
        )
        assert len(calls) == before
