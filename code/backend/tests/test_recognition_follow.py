from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from todo_backend.integrations.ai.client import Proposal, Proposals
from todo_backend.main import create_app
from todo_backend.modules.sources.follow import attempts, rules, send_due
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources


def test_recognition_and_reminder_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "ai.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1") as client:
        client.get("/api/session", headers={"X-Todo-Client": "web"})
        parent = None
        for kind in ("goal", "module", "thing"):
            parent = client.post(
                "/api/items",
                json={"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": kind},
            ).json()["id"]
        assert isinstance(parent, str)
        sid = str(uuid4())
        body = {
            "id": sid,
            "context": parent,
            "kind": "document",
            "address": "https://example.feishu.cn/wiki/Test123",
            "enabled": True,
            "consent": True,
            "ai_consent": True,
        }
        assert client.post("/api/sources", json=body).status_code == 200
        with app.state.engine.begin() as conn:
            conn.execute(update(sources).values(content="请整理清单"))
        proposal = Proposal(
            action="new",
            thing_id=parent,
            name="整理清单",
            evidence="请整理清单",
            owner="测试",
            plan_end="2026-11-13",
        )
        monkeypatch.setattr(
            "todo_backend.modules.sources.recognition.recognize",
            lambda content, context: Proposals(suggestions=[proposal]),
        )
        analyze_source(app.state.engine, sid)
        analyze_source(app.state.engine, sid)
        suggested = client.get("/api/sources/suggestions").json()
        assert len(suggested) == 1
        assert len(client.get("/api/items").json()) == 3
        endpoint = "/api/sources/suggestions/" + suggested[0]["id"]
        accepted = client.post(endpoint, json={"accept": True})
        assert accepted.status_code == 200, accepted.text
        saved = accepted.json()["saved"]
        assert client.post(endpoint, json={"accept": True}).json()["saved"]["id"] == saved["id"]
        assert len(client.get("/api/items").json()) == 4
        rule = {
            "recipient": "ou_test",
            "content": "请反馈进展",
            "at": "09:00",
            "cap": 2,
            "enabled": True,
            "event_version": saved["version"],
        }
        path = "/api/sources/follow/" + saved["id"]
        assert client.post(path, json={**rule, "recipient": ""}).status_code == 422
        assert client.post(path, json={**rule, "event_version": 0}).status_code == 409
        response = client.post(path, json=rule)
        assert response.status_code == 200, response.text
        assert response.json()["enabled"] is True
        assert client.get("/api/sources/follow").json()[0]["recipient"] == "ou_test"
        with app.state.engine.begin() as conn:
            conn.execute(update(rules).values(next_run=0))
        sent = []

        def fake_send(recipient: str, content: str, operation_id: str) -> str:
            sent.append(operation_id)
            return "om_test"

        monkeypatch.setattr("todo_backend.integrations.feishu_cli.sender.send_message", fake_send)
        send_due(app.state.engine)
        send_due(app.state.engine)
        assert len(sent) == 1
        with app.state.engine.connect() as conn:
            assert conn.execute(select(attempts.c.state)).scalar_one() == "confirmed"
        assert client.get("/api/sources/follow").json()[0]["count"] == 1
        # A model claiming a different thing must never create a proposal there.
        with app.state.engine.begin() as conn:
            conn.execute(update(sources).values(content="另一个来源", ai_hash=""))
        proposal.thing_id = str(uuid4())
        analyze_source(app.state.engine, sid)
        assert client.get("/api/sources").json()[0]["enabled"] is False
