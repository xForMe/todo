"""Visual suggestions and attachments compose with the real work write contracts."""

import base64
from io import BytesIO
from typing import cast
from urllib.request import Request
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_event_images import config, event, png, send
from test_event_images import fake_storage as images_fixture
from test_work import client as client_fixture

from todo_backend.integrations.ai import vision
from todo_backend.modules.images import model_settings
from todo_backend.modules.images.repository import vision_settings
from todo_backend.modules.work.service import WorkError

client = client_fixture
fake_storage = images_fixture


def test_model_settings_private_and_versioned(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setenv("TODO_VISION_MODEL", "server-model")
    monkeypatch.setenv("TODO_VISION_API_KEY", "server-key")
    path = "/api/model-settings"
    assert client.get(path).json() == {
        "model": "server-model",
        "key_source": "server",
        "revision": 0,
    }
    operation_id = str(uuid4())
    body = {
        "operation_id": operation_id,
        "expected_revision": 0,
        "model": "user-model",
        "api_key": "private-test-key",
    }
    saved = client.put(path, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"model": "user-model", "key_source": "saved", "revision": 1}
    assert client.put(path, json=body).json() == saved.json()
    receipt = path + "/operations/" + operation_id
    assert client.get(receipt).json() == saved.json()
    assert client.put(path, json={**body, "api_key": "other-key"}).status_code == 409
    assert client.put(path, json={**body, "operation_id": str(uuid4())}).status_code == 409
    rejected = client.put(path, json={**body, "api_key": {"value": body["api_key"]}})
    assert rejected.status_code == 422 and body["api_key"] not in rejected.text
    engine = cast(FastAPI, client.app).state.engine
    with engine.connect() as conn:
        stored = conn.execute(select(vision_settings)).mappings().one()
        assert body["api_key"] not in stored["encrypted_key"]
        assert model_settings.resolve(conn, stored["account"]) == ("user-model", "private-test-key")
        assert model_settings.resolve(conn, "other-account") == ("server-model", "server-key")
        with pytest.raises(WorkError, match="尚未查到保存结果"):
            model_settings.receipt(conn, "other-account", operation_id)

    def catalog(request: Request, timeout: int) -> BytesIO:
        assert request.get_method() == "GET" and request.data is None and timeout == 15
        assert request.full_url == "https://api.uaiapi.com/v1/models"
        assert request.get_header("Authorization") == "Bearer private-test-key"
        return BytesIO(b'{"data":[{"id":"user-model"}]}')

    monkeypatch.setattr(vision, "urlopen", catalog)
    assert client.post(path + "/check").status_code == 200
    edited = client.put(
        path,
        json={"operation_id": str(uuid4()), "expected_revision": 1, "model": "other-model"},
    )
    assert edited.json() == {"model": "other-model", "key_source": "saved", "revision": 2}
    assert client.post(path + "/check").status_code == 422
    client.cookies.clear()
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("scope", ["thing", "event"])
def test_analyze_then_confirm_with_source(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, scope: str
) -> None:
    config(client)
    row = event(client)
    target = row["parent"] if scope == "thing" else row["id"]
    image_id = str(uuid4())
    upload = client.post(
        f"/api/items/{target}/images",
        data={
            "operation_id": image_id,
            "expected_version": 1,
        },
        files={"file": ("source.png", png(), "image/png")},
    )
    assert upload.json()["state"] == "ready", upload.text
    monkeypatch.setenv("TODO_VISION_MODEL", "server-vision-test")
    monkeypatch.setenv("TODO_VISION_API_KEY", "server-test-key")
    assert (
        client.put(
            "/api/model-settings",
            json={
                "model": "vision-test",
                "api_key": "offline-test-key",
                "operation_id": str(uuid4()),
                "expected_revision": 0,
            },
        ).status_code
        == 200
    )
    requests = []

    def response(payload: dict[str, object], key: str) -> object:
        requests.append(payload)
        assert key == "offline-test-key"
        assert payload["model"] == "vision-test"
        messages = cast(list[dict[str, object]], payload["messages"])
        parts = cast(list[dict[str, object]], messages[1]["content"])
        inline = cast(dict[str, str], parts[-1]["image_url"])["url"]
        assert inline.startswith("data:image/png;base64,")
        assert base64.b64decode(inline.split(",", 1)[1]) == png()
        return {
            "summary": "待核对",
            "candidates": [
                {
                    "name": "复核图片问题",
                    "owner": "未知负责人",
                    "planEnd": "2026-11-21",
                    "image_id": image_id,
                    "evidence": "图中列出待核对事项",
                }
            ],
        }

    monkeypatch.setattr(vision, "request_json", response)
    path = f"/api/items/{target}/image-actions"
    analyzed = client.post(path, json={"image_ids": [image_id]})
    assert analyzed.status_code == 200, analyzed.text
    proposal = analyzed.json()
    assert len(client.get("/api/items").json()) == 4
    assert proposal["candidates"][0]["owner"] == ""
    assert proposal["candidates"][0]["planEnd"] == ""
    batch = f"{path}/{proposal['id']}"
    assert client.get(batch + "/result").status_code == 404
    body = {"candidates": [{"index": 0, "name": "复核验收问题"}]}
    created = client.post(batch + "/confirm", json=body)
    assert created.status_code == 200, created.text
    assert client.post(batch + "/confirm", json=body).json() == created.json()
    assert client.get(batch + "/result").json() == created.json()
    assert len(requests) == 1
    child = created.json()["created"][0]["id"]
    assert len(client.get("/api/items").json()) == 5
    structure = client.get(f"/api/events/{row['id']}/structure").json()
    branch = next((b for b in structure["branches"] if b["child_id"] == child), None)
    assert (branch["parent_id"] if branch else None) == (target if scope == "event" else None)
    source = client.get(f"/api/events/{child}/images").json()["source"]
    assert source["name"] == "source.png" and source["url"].startswith("https://example.invalid/")


def test_model_scope_and_follow_attachment(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    row = event(client)
    image_id = str(uuid4())
    image = send(client, row, image_id)
    target = row["id"]
    path = f"/api/items/{target}"
    monkeypatch.delenv("TODO_VISION_MODEL", raising=False)
    assert client.post(path + "/image-actions", json={"image_ids": [image_id]}).status_code == 503
    assert (
        client.post(
            f"/api/items/{row['parent']}/image-actions",
            json={
                "image_ids": [image_id],
            },
        ).status_code
        == 409
    )
    follow_path = path + "/daily-follow-ups"
    view = client.get(follow_path).json()
    body = {
        "operation_id": str(uuid4()),
        "day": view["day"],
        "expected_version": 1,
        "expected_revision": view["revision"],
        "content": "已核对现场",
        "skip_ai": True,
        "image_ids": [image_id],
    }
    saved = client.post(follow_path, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["image_ids"] == [image_id]
    assert client.post(follow_path, json=body).json() == saved.json()
    monkeypatch.setenv("TODO_VISION_MODEL", "vision-test")
    monkeypatch.setenv("TODO_VISION_API_KEY", "offline-test-key")
    monkeypatch.setattr(
        vision,
        "analyze",
        lambda *_: {
            "summary": "结果",
            "candidates": [
                {
                    "name": "复核现场",
                    "image_id": image_id,
                    "evidence": "图中文字",
                }
            ],
        },
    )
    analyzed = client.post(path + "/image-actions", json={"image_ids": [image_id]})
    assert analyzed.status_code == 200, analyzed.text
    remove = client.post(
        f"/api/events/{target}/images/{image_id}/remove",
        json={
            "operation_id": str(uuid4()),
            "expected_revision": image["revision"],
        },
    )
    assert remove.status_code == 200, remove.text
    confirm = client.post(
        f"{path}/image-actions/{analyzed.json()['id']}/confirm",
        json={
            "candidates": [{"index": 0, "name": "复核现场"}],
        },
    )
    assert confirm.status_code == 409
    assert len(client.get("/api/items").json()) == 4
