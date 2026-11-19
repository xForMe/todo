"""Verify model configuration, credential isolation and real scene requests to a stub."""

import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import cast
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from test_daily_follow_up import command
from test_event_images import config, event, send
from test_event_images import fake_storage as images_fixture
from test_work import client as client_fixture

from todo_backend.modules.model_catalog import SCENES, catalogs
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources

client = client_fixture
fake_storage = images_fixture
PATH = "/api/model-catalog"


def profile(name: str, base: str, *, vision: bool = False) -> dict[str, str | bool]:
    return {
        "id": str(uuid4()),
        "name": name,
        "model": name.lower(),
        "base_url": base,
        "vision": vision,
    }


def update_catalog(
    client: TestClient,
    revision: int,
    profiles: list[dict[str, str | bool]],
    assignments: dict[str, str],
) -> dict[str, object]:
    payload = {
        "operation_id": str(uuid4()),
        "expected_revision": revision,
        "models": profiles,
        "assignments": assignments,
    }
    reply = client.put(PATH, json=payload)
    assert reply.status_code == 200, reply.text
    return payload


def test_catalog_writes_encrypt_keys_and_validate_references(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TODO_STORAGE_ENCRYPTION_KEY", Fernet.generate_key().decode())
    text = profile("Text", "https://text.example/v1/chat/completions/")
    visual = profile("Vision", "https://vision.example/v1", vision=True)
    text_id, image_id = str(text["id"]), str(visual["id"])
    assert client.get(PATH).json()["models"] == []
    route = {"image_analysis": image_id, "matter_decomposition": text_id}
    payload = update_catalog(client, 0, [{**text, "api_key": "my-secret"}, visual], route)
    first = client.get(PATH)
    result = first.json()
    assert (result["revision"], result["assignments"]) == (1, route)
    assert result["models"][0]["base_url"] == "https://text.example/v1"
    assert result["models"][0]["has_key"] and "my-secret" not in first.text
    assert client.put(PATH, json=payload).json() == result
    assert client.get(f"{PATH}/operations/{payload['operation_id']}").json() == result
    with cast(FastAPI, client.app).state.engine.connect() as conn:
        raw = conn.execute(select(catalogs.c.configuration)).scalar_one()
        assert "my-secret" not in raw and raw != first.text
    with monkeypatch.context() as other:
        other.setenv("TODO_OWNER_ID", "other-catalog-account")
        assert client.get(PATH).json()["models"] == []
        assert client.get(f"{PATH}/operations/{payload['operation_id']}").status_code == 404
        assert client.post(f"{PATH}/{text_id}/check").status_code == 404

    revision = {"operation_id": str(uuid4()), "expected_revision": 1}
    request = {**payload, **revision}
    assert client.put(PATH, json={**request, "models": [text]}).status_code == 422
    assert (
        client.put(PATH, json={**request, "assignments": {"image_analysis": text_id}}).status_code
        == 422
    )
    for bad_url in (
        "http://example.com/v1",
        "http://169.254.169.254/v1",
        "http://127.0.0.1:8000/v1",
        "https://user:secret@example.com/v1",
    ):
        response = client.put(
            PATH, json={**request, "models": [{**text, "base_url": bad_url}, visual]}
        )
        assert response.status_code == 422 and bad_url not in response.text

    switched = {**text, "base_url": "https://replacement.example/v1"}
    denied = client.put(PATH, json={**request, "models": [switched, visual]})
    assert denied.status_code == 422 and "地址已变更" in denied.text
    unnamed_key = client.put(PATH, json={**request, "models": [text, visual]})
    assert unnamed_key.json()["models"][0]["has_key"]
    assert client.put(PATH, json={**request, "models": [switched, visual]}).status_code == 409
    update_catalog(client, 2, [{**switched, "clear_key": True}, visual], route)
    assert client.get(PATH).json()["models"][0]["has_key"] is False


@pytest.fixture
def provider() -> Iterator[tuple[str, list[tuple[str, str, dict[str, object]]]]]:
    requests: list[tuple[str, str, dict[str, object]]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def response(self, output: object) -> None:
            body = json.dumps(output).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            requests.append((self.path, self.headers.get("Authorization", ""), {}))
            if self.path.startswith("/redirect/"):
                self.send_response(302)
                self.send_header("Location", "/elsewhere")
                self.end_headers()
                return
            self.response({"data": [{"id": "visual"}]})

        def do_POST(self) -> None:
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, self.headers.get("Authorization", ""), payload))
            instructions = payload["messages"][0]["content"]
            result: dict[str, object] = {"suggestions": []}
            if "根据工作内容判断事情类型" in instructions:
                result = {"type_id": "issue"}
            elif "识别用户主动保存的当日跟进" in instructions:
                result = {"kind": "none"}
            elif payload["model"] == "visual" and "根据用户图片" in instructions:
                result = {"summary": "图片已分析", "candidates": []}
            self.response({"choices": [{"message": {"content": json.dumps(result)}}]})

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requests
        finally:
            server.shutdown()
            thread.join()


def test_live_requests_use_scene_specific_endpoint_model_and_key(
    client: TestClient,
    provider: tuple[str, list[tuple[str, str, dict[str, object]]]],
    fake_storage: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base, calls = provider
    monkeypatch.setenv("TODO_UAIAPI_KEY", "legacy-not-for-custom")
    monkeypatch.delenv("TODO_VISION_MODEL", raising=False)
    config(client)
    text = profile("Writer", base + "/text/v1")
    visual = profile("Visual", base + "/image/v1", vision=True)
    redirect = profile("Redirect", base + "/redirect/v1")
    assignments = {scene: str(text["id"]) for scene in SCENES}
    assignments["image_analysis"] = str(visual["id"])
    update_catalog(client, 0, [text, {**visual, "api_key": "image-key"}, redirect], assignments)
    assert client.post(f"{PATH}/{visual['id']}/check").status_code == 200
    assert client.post(f"{PATH}/{redirect['id']}/check").status_code == 502
    assert calls[:2] == [
        ("/image/v1/models", "Bearer image-key", {}),
        ("/redirect/v1/models", "", {}),
    ]
    row = event(client)
    item_id = str(row["id"])
    matter_id = str(row["parent"])
    other = client.post(
        "/api/items",
        json={
            "operation_id": str(uuid4()),
            "name": "先准备材料",
            "type": "event",
            "parent": matter_id,
        },
    )
    assert other.status_code == 200
    image_id = str(uuid4())
    assert send(client, row, image_id)["state"] == "ready"
    matter = f"/api/matters/{matter_id}/decomposition"
    snapshot = client.get(f"/api/events/{item_id}/structure").json()["snapshot"]
    for endpoint, body in (
        (f"/api/items/{item_id}/image-actions", {"image_ids": [image_id]}),
        (matter, {"snapshot": client.get(matter).json()["snapshot"]}),
        (f"/api/events/{item_id}/decomposition", {"consent": True, "snapshot": snapshot}),
        (
            f"/api/events/{item_id}/predecessor-recommendations",
            {"consent": True, "snapshot": snapshot},
        ),
        (f"/api/items/{item_id}/daily-follow-ups", command(client, item_id, "已核对材料")),
    ):
        reply = client.post(endpoint, json=body)
        assert reply.status_code == 200, (endpoint, reply.text)

    source_id = str(uuid4())
    reply = client.post(
        "/api/sources",
        json={
            "id": source_id,
            "kind": "chat",
            "address": "oc_modelcatalogtest",
            "enabled": True,
            "consent": True,
            "ai_consent": True,
        },
    )
    assert reply.status_code == 200, reply.text
    engine = cast(FastAPI, client.app).state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == source_id).values(content="核对清单"))
    analyze_source(engine, source_id)
    assert (calls[2][0], calls[2][1], calls[2][2]["model"]) == (
        "/image/v1/chat/completions",
        "Bearer image-key",
        "visual",
    )
    assert "data:image/png;base64," in json.dumps(calls[2][2])
    assert len(calls[3:]) == 6
    for path, auth, payload in calls[3:]:
        assert (path, auth, payload["model"]) == ("/text/v1/chat/completions", "", "writer")
        assert "thinking" not in payload
