"""Private images preserve scope, write certainty and encrypted credentials."""

import io
from typing import cast
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from test_work import client as client_fixture
from test_work import payload

from todo_backend.modules.images import configuration
from todo_backend.modules.images.repository import profiles
from todo_backend.modules.work.service import WorkError

client = client_fixture


class FakeStorage:
    objects: dict[str, dict[str, object]] = {}
    content: dict[str, bytes] = {}
    puts = 0
    uncertain = False

    def __init__(self, region: str, bucket: str, secret_id: str, secret_key: str) -> None:
        self.bucket = bucket

    def put(self, key: str, data: bytes, mime: str, sha256: str) -> None:
        type(self).puts += 1
        self.content[self.bucket + key] = data
        self.objects[self.bucket + key] = {
            "Content-Length": str(len(data)),
            "Content-Type": mime,
            "x-cos-meta-sha256": sha256,
        }
        if self.uncertain:
            raise WorkError(502, "uncertain")

    def head(self, key: str) -> dict[str, object] | None:
        return self.objects.get(self.bucket + key)

    def check(self) -> None:
        pass

    def read(self, key: str, limit: int) -> bytes:
        return self.content[self.bucket + key][: limit + 1]

    def url(self, key: str) -> str:
        return "https://example.invalid/" + self.bucket + "/" + key


@pytest.fixture(autouse=True)
def fake_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TODO_STORAGE_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(configuration, "Storage", FakeStorage)
    FakeStorage.objects = {}
    FakeStorage.content = {}
    FakeStorage.puts = 0
    FakeStorage.uncertain = False


def config(client: TestClient, **extra: object) -> dict[str, object]:
    body = {
        "operation_id": str(uuid4()),
        "expected_revision": 0,
        "region": "ap-shanghai",
        "bucket": "cc-1300161961",
        "secret_id": "test-id",
        "secret_key": "test-secret",
        **extra,
    }
    response = client.put("/api/image-storage", json=body)
    assert response.status_code == 200, response.text
    assert "test-secret" not in response.text
    return body


def event(client: TestClient) -> dict[str, object]:
    parent = None
    row: dict[str, object] = {}
    for kind in ("goal", "module", "thing", "event"):
        row = client.post("/api/items", json=payload(kind, parent)).json()
        parent = str(row["id"])
    return row


def png() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (2, 2)).save(stream, format="PNG")
    return stream.getvalue()


def send(
    client: TestClient, row: dict[str, object], op: str, data: bytes | None = None
) -> dict[str, object]:
    response = client.post(
        f"/api/events/{row['id']}/images",
        data={"operation_id": op, "expected_version": str(row["version"])},
        files={"file": ("现场.png", png() if data is None else data, "image/png")},
    )
    assert response.status_code == 200, response.text
    return cast(dict[str, object], response.json())


def test_config_replay_encryption_and_rotation(client: TestClient) -> None:
    assert client.get("/api/image-storage").json()["has_credentials"] is False
    body = config(client)
    assert client.put("/api/image-storage", json=body).json()["revision"] == 1
    assert client.put("/api/image-storage", json={**body, "bucket": "new-123"}).status_code == 409
    with cast(FastAPI, client.app).state.engine.connect() as conn:
        ciphertext = conn.execute(select(profiles.c.credentials)).scalar_one()
        assert "test-secret" not in ciphertext
    keep = {k: v for k, v in body.items() if not k.startswith("secret_")}
    keep.update(operation_id=str(uuid4()), expected_revision=1)
    assert client.put("/api/image-storage", json=keep).json()["has_credentials"]
    assert client.post("/api/image-storage/check").status_code == 200
    assert FakeStorage.puts == 0
    assert client.put("/api/image-storage", json=keep).status_code == 200
    assert (
        client.put("/api/image-storage", json={**keep, "operation_id": str(uuid4())}).status_code
        == 409
    )


def test_ready_replay_remove_and_scope(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    row = event(client)
    op = str(uuid4())
    result = send(client, row, op)
    assert result["state"] == "ready"
    assert send(client, row, op) == result
    assert FakeStorage.puts == 1
    url = f"/api/events/{row['id']}/images"
    assert "cc-1300161961" in client.get(url).json()["images"][0]["url"]
    monkeypatch.setenv("TODO_OWNER_ID", "other")
    assert client.get(url).status_code == 404
    assert client.post(url + f"/{op}/reconcile").status_code == 404
    monkeypatch.setenv("TODO_OWNER_ID", "personal")
    remove_body = {"operation_id": str(uuid4()), "expected_revision": result["revision"]}
    removed = client.post(url + f"/{op}/remove", json=remove_body)
    assert removed.status_code == 200
    assert removed.json()["state"] == "removed"
    assert client.post(url + f"/{op}/remove", json=remove_body).json() == removed.json()
    assert client.get(url).json()["images"] == []
    assert len(FakeStorage.objects) == 1


def test_unknown_put_requires_head_before_retry(client: TestClient) -> None:
    config(client)
    row = event(client)
    op = str(uuid4())
    FakeStorage.uncertain = True
    assert send(client, row, op)["state"] == "unknown"
    assert send(client, row, op)["state"] == "unknown"
    assert FakeStorage.puts == 1
    result = client.post(f"/api/events/{row['id']}/images/{op}/reconcile")
    assert result.json()["state"] == "ready"
    assert FakeStorage.puts == 1


def test_invalid_content_and_unconfigured_never_write(client: TestClient) -> None:
    row = event(client)
    url = f"/api/events/{row['id']}/images"
    form = {"operation_id": str(uuid4()), "expected_version": "1"}
    assert client.post(url, data=form, files={"file": ("fake.png", b"<svg/>")}).status_code == 422
    assert client.post(url, data=form, files={"file": ("x.png", png())}).status_code == 409
    assert FakeStorage.puts == 0
    config(client)
    form["expected_version"] = "100"
    assert client.post(url, data=form, files={"file": ("x.png", png())}).status_code == 409
    assert FakeStorage.puts == 0


def test_missing_key_and_old_profile_survive_bucket_change(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = config(client)
    row = event(client)
    send(client, row, str(uuid4()))
    config(client, expected_revision=1, bucket="new-123")
    assert (
        "cc-1300161961" in client.get(f"/api/events/{row['id']}/images").json()["images"][0]["url"]
    )
    monkeypatch.delenv("TODO_STORAGE_ENCRYPTION_KEY")
    assert (
        client.put(
            "/api/image-storage",
            json={**body, "operation_id": str(uuid4()), "expected_revision": 2},
        ).status_code
        == 503
    )


def test_sdk_contract_disables_retries_and_uses_actual_metadata_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from todo_backend.integrations.cos import Storage

    client = Storage("ap-shanghai", "cc-1300161961", "demo-id", "demo-key")
    assert vars(client.client)["_retry"] == 0
    captured: dict[str, object] = {}

    def put(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {}

    monkeypatch.setattr(client.client, "put_object", put)
    client.put("key", b"image", "image/png", "digest")
    assert captured["Metadata"] == {"x-cos-meta-sha256": "digest"}
    assert captured["ACL"] == "private"


def test_interrupted_reservation_does_not_resend_and_checks_capacity(client: TestClient) -> None:
    from todo_backend.modules.images.service import reserve

    config(client)
    row = event(client)
    engine = cast(FastAPI, client.app).state.engine
    op = str(uuid4())
    reserve(engine, "personal", str(row["id"]), op, 1, "现场.png", png(), "image/png")
    assert send(client, row, op)["state"] == "pending"
    assert FakeStorage.puts == 0
    assert client.post(f"/api/events/{row['id']}/images/{op}/reconcile").json()["state"] == "absent"
    assert send(client, row, op)["state"] == "ready"
    for _ in range(19):
        reserve(engine, "personal", str(row["id"]), str(uuid4()), 1, "现场.png", png(), "image/png")
    with pytest.raises(WorkError, match="最多20张"):
        reserve(engine, "personal", str(row["id"]), str(uuid4()), 1, "现场.png", png(), "image/png")
    assert FakeStorage.puts == 1


def test_validation_does_not_echo_secret_and_upload_limit(client: TestClient) -> None:
    response = client.put("/api/image-storage", json={"secret_key": {"bad": "never-echo-secret"}})
    assert response.status_code == 422
    assert "never-echo-secret" not in response.text
    row = event(client)
    response = client.post(
        f"/api/events/{row['id']}/images",
        data={"operation_id": str(uuid4()), "expected_version": "1"},
        files={"file": ("huge.png", b"x" * (12 * 1024 * 1024), "image/png")},
    )
    assert response.status_code == 413
    assert FakeStorage.puts == 0


def test_same_id_and_key_are_rejected_without_echo(client: TestClient) -> None:
    body = {
        "operation_id": str(uuid4()),
        "expected_revision": 0,
        "region": "ap-shanghai",
        "bucket": "cc-1300161961",
        "secret_id": "demo-identical",
        "secret_key": "demo-identical",
    }
    result = client.put("/api/image-storage", json=body)
    assert result.status_code == 422
    assert "不能相同" in result.json()["detail"]
    assert "demo-identical" not in result.text
    assert client.get("/api/image-storage").json()["revision"] == 0


def test_preexisting_identical_credentials_fail_before_cos(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from sqlalchemy import update

    config(client)
    with cast(FastAPI, client.app).state.engine.begin() as conn:
        conn.execute(
            update(profiles).values(
                credentials=configuration.cipher()
                .encrypt(json.dumps(["demo-identical", "demo-identical"]).encode())
                .decode()
            )
        )

    def forbidden_storage(*args: object) -> FakeStorage:
        raise AssertionError("Invalid credentials must be rejected before constructing COS")

    monkeypatch.setattr(configuration, "Storage", forbidden_storage)
    result = client.post("/api/image-storage/check")
    assert result.status_code == 422
    assert "不能相同" in result.json()["detail"]
    assert "demo-identical" not in result.text
