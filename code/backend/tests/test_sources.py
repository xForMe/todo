from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from todo_backend.main import create_app
from todo_backend.modules.sources.repository import sources
from todo_backend.modules.sources.worker import poll_sources


def test_scoped_sources_and_stale_reads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "sources.db"))
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    command.upgrade(Config("alembic.ini"), "head")
    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.get("/api/sources").status_code == 401
        client.get("/api/session", headers={"X-Todo-Client": "web"})
        parent = None
        for kind in ("goal", "module", "thing"):
            result = client.post(
                "/api/items",
                json={"operation_id": str(uuid4()), "type": kind, "parent": parent, "name": kind},
            )
            assert result.status_code == 200
            parent = result.json()["id"]
        body = {
            "id": str(uuid4()),
            "context": parent,
            "kind": "document",
            "address": "https://example.feishu.cn/wiki/Test123?token=secret",
            "enabled": True,
            "consent": True,
        }
        r = client.post("/api/sources", json={**body, "consent": False})
        assert r.status_code == 422
        r = client.post("/api/sources", json=body)
        assert r.status_code == 200, r.text
        assert "secret" not in r.text
        assert client.post("/api/sources", json=body).json()["version"] == 1
        assert client.post("/api/sources", json={**body, "id": str(uuid4())}).status_code == 409
        assert (
            client.post("/api/sources", json={**body, "context": str(uuid4())}).status_code == 404
        )
        assert (
            client.post(
                "/api/sources", json={**body, "enabled": False, "expected_version": 9}
            ).status_code
            == 409
        )
        engine = app.state.engine

        def fake_read(kind: str, address: str) -> str:
            # Pause during the external read: returned content must be discarded.
            result = client.post(
                "/api/sources", json={**body, "enabled": False, "expected_version": 1}
            )
            assert result.status_code == 200
            return "must not commit after pause"

        monkeypatch.setattr("todo_backend.modules.sources.worker.read_source", fake_read)
        poll_sources(engine)
        saved = client.get("/api/sources").json()[0]
        assert saved["content"] == ""
        assert saved["enabled"] is False
        assert client.post("/api/sources", json={**body, "expected_version": 2}).status_code == 200
        monkeypatch.setattr("todo_backend.modules.sources.worker.read_source", lambda k, a: "正文")
        poll_sources(engine)
        with engine.connect() as conn:
            assert conn.execute(select(sources.c.content)).scalar_one() == "正文"
        monkeypatch.setenv("TODO_OWNER_ID", "other")
        assert client.get("/api/sources").json() == []
        monkeypatch.setenv("TODO_OWNER_ID", "personal")
        with engine.begin() as conn:
            conn.execute(update(sources).values(next_run=0))
        assert (
            client.post(
                "/api/sources",
                json={**body, "enabled": False, "removed": True, "expected_version": 3},
            ).status_code
            == 200
        )
        assert client.get("/api/sources").json() == []
