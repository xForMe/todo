"""Account-wide chat classification and explicit uncertain assignment."""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from sqlalchemy import insert, select, update

from todo_backend.integrations.ai.client import Proposal, Proposals
from todo_backend.main import create_app
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources
from todo_backend.modules.work.repository import items


def test_global_chat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "global.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1") as client:
        client.get("/api/session", headers={"X-Todo-Client": "web"})
        things = []
        for branch in range(2):
            parent = None
            for kind in ("goal", "module", "thing"):
                parent = client.post(
                    "/api/items",
                    json={
                        "operation_id": str(uuid4()),
                        "type": kind,
                        "parent": parent,
                        "name": f"{branch}-{kind}",
                    },
                ).json()["id"]
            things.append(parent)
        body = {
            "id": str(uuid4()),
            "kind": "chat",
            "address": "oc_test",
            "enabled": True,
            "consent": True,
            "ai_consent": True,
        }
        result = client.post("/api/sources", json=body)
        assert result.status_code == 200
        assert result.json()["context"] == ""
        assert client.post("/api/sources", json={**body, "id": str(uuid4())}).status_code == 409
        with app.state.engine.begin() as conn:
            conn.execute(update(sources).values(content="请整理清单"))
            foreign = dict(
                conn.execute(select(items).where(items.c.id == things[0])).mappings().one()
            )
            foreign.update(id=str(uuid4()), account="foreign")
            conn.execute(insert(items).values(**foreign))

        def recognize(content: str, context: str) -> Proposals:
            scope = json.loads(context)
            assert {r["type"] for r in scope} == {"goal", "module", "thing"}
            assert {r["id"] for r in scope if r["type"] == "thing"} == set(things)
            return Proposals(
                suggestions=[Proposal(action="new", thing_id="", name="整理清单", evidence=content)]
            )

        monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", recognize)
        analyze_source(app.state.engine, str(body["id"]))
        suggested = client.get("/api/sources/suggestions").json()
        assert len(suggested) == 1 and suggested[0]["thing_id"] == ""
        endpoint = "/api/sources/suggestions/" + suggested[0]["id"]
        assert client.post(endpoint, json={"accept": True}).status_code == 422
        edited = json.loads(suggested[0]["body"])
        edited["thing_id"] = str(uuid4())
        assert client.post(endpoint, json={"accept": True, "edited": edited}).status_code == 422
        edited["thing_id"] = things[1]
        accepted = client.post(endpoint, json={"accept": True, "edited": edited})
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["saved"]["parent"] == things[1]
        assert len(client.get("/api/items").json()) == 7
