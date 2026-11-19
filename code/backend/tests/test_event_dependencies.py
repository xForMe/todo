"""Exercise the full dependency slice through the scoped HTTP endpoints."""

import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from test_event_structure import body, seed, status
from test_event_structure import client as client

from todo_backend.modules.work import predecessor_recommendation


def create_event(client: TestClient, matter: str, name: str) -> str:
    result = client.post(
        "/api/items",
        json={"type": "event", "parent": matter, "name": name, "operation_id": str(uuid4())},
    )
    assert result.status_code == 200, result.text
    return str(result.json()["id"])


def reviewed(client: TestClient, current: str, *previous: str) -> dict[str, object]:
    view = client.get(f"/api/events/{current}/structure")
    assert view.status_code == 200, view.text
    return {
        "operation_id": str(uuid4()),
        "action": "predecessors",
        "snapshot": view.json()["snapshot"],
        "predecessor_ids": list(previous),
    }


def test_dependencies_coexist_with_links_and_survive_status_edits(client: TestClient) -> None:
    ids = seed(client)
    previous = ids["event"]
    current = create_event(client, ids["thing"], "确认交付")
    assert status(client, current, "working") == 200
    path = f"/api/events/{current}/children"
    write = reviewed(client, current, previous)
    link = {"action": "link", "target": previous, "snapshot": write["snapshot"]}
    assert client.post(path, json={**link, "operation_id": str(uuid4())}).status_code == 200
    assert client.post(path, json=write).status_code == 409
    write = reviewed(client, current, previous)
    result = client.post(path, json=write)
    assert result.status_code == 200, result.text
    assert client.post(path, json=write).json() == result.json()
    assert client.get(f"/api/event-operations/{write['operation_id']}").json() == result.json()
    assert client.post(path, json={**write, "predecessor_ids": []}).status_code == 409
    for value in ("completed", "working", "cancelled"):
        assert status(client, previous, value) == 200
        workbench = client.get("/api/workbench").json()
        assert workbench["dependencies"] == [{"event_id": current, "predecessor_id": previous}]
        current_status = next(
            item["status"] for item in workbench["items"] if item["id"] == current
        )
        assert current_status == "working"
        assert len(workbench["links"]) == 1
    assert client.post(path, json=reviewed(client, current)).status_code == 200
    assert client.get("/api/workbench").json()["dependencies"] == []


def test_scope_cycles_parent_deadlock_and_move(client: TestClient) -> None:
    here, other = seed(client), seed(client)
    parent = here["event"]
    path = f"/api/events/{parent}/children"
    a = create_event(client, here["thing"], "第一阶段")
    b = create_event(client, here["thing"], "第二阶段")
    assert client.post(path, json=reviewed(client, parent, other["event"])).status_code == 422
    assert client.post(path, json=reviewed(client, parent, parent)).status_code == 422
    assert client.post(path, json=reviewed(client, parent, a, a)).status_code == 422
    assert client.post(path, json=reviewed(client, parent, a)).status_code == 200
    assert client.post(f"/api/events/{a}/children", json=reviewed(client, a, b)).status_code == 200
    cyclic = client.post(f"/api/events/{b}/children", json=reviewed(client, b, parent))
    assert cyclic.status_code == 409
    result = client.post(path, json=body(client, here))
    assert result.status_code == 200, result.text
    child = result.json()["created"][0]
    deadlock = client.post(f"/api/events/{child}/children", json=reviewed(client, child, parent))
    assert deadlock.status_code == 409
    move = client.get(f"/api/events/{a}/move", params={"target_id": other["thing"]})
    assert move.status_code == 409
    assert "前置" in move.json()["detail"]


def test_deleted_predecessor_is_visible_as_an_unresolved_edge(client: TestClient) -> None:
    ids = seed(client)
    previous = ids["event"]
    current = create_event(client, ids["thing"], "待交付")
    path = f"/api/events/{current}/children"
    assert client.post(path, json=reviewed(client, current, previous)).status_code == 200
    deletion_path = f"/api/items/{previous}/deletion"
    preview = client.get(deletion_path).json()
    removed = client.post(
        deletion_path, json={"operation_id": str(uuid4()), "snapshot": preview["snapshot"]}
    )
    assert removed.status_code == 200, removed.text
    workbench = client.get("/api/workbench").json()
    assert previous not in {item["id"] for item in workbench["items"]}
    assert workbench["dependencies"] == [{"event_id": current, "predecessor_id": previous}]
    assert client.post(path, json=reviewed(client, current)).status_code == 200
    assert client.get("/api/workbench").json()["dependencies"] == []


def test_model_aliases_scope_and_no_write(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    here, other = seed(client), seed(client)
    current = create_event(client, here["thing"], "使用校验结果")
    candidate = create_event(client, here["thing"], "完成校验")
    snapshot = reviewed(client, current)["snapshot"]
    url = f"/api/events/{current}/predecessor-recommendations"
    assert client.post(url, json={"consent": False, "snapshot": snapshot}).status_code == 422

    def model(_: str, content: str, context: str) -> object:
        entries = json.loads(context)
        assert content == ""
        assert entries["current"]["title"] == "使用校验结果"
        assert all(key not in context for key in (current, candidate, other["event"]))
        number = next(row["number"] for row in entries["candidates"] if row["title"] == "完成校验")
        return {
            "suggestions": [
                {"candidate": number, "reason": "产出校验结果"},
                {"candidate": number, "reason": "重复"},
                {"candidate": 999, "reason": "范围之外"},
            ]
        }

    monkeypatch.setattr(predecessor_recommendation, "call_json", model)
    output = client.post(url, json={"consent": True, "snapshot": snapshot})
    assert output.status_code == 200, output.text
    assert output.json() == [{"id": candidate, "reason": "产出校验结果"}]
    assert client.get("/api/workbench").json()["dependencies"] == []

    def changes_while_generating(*_: str) -> object:
        assert status(client, candidate, "completed") == 200
        return {"suggestions": []}

    monkeypatch.setattr(predecessor_recommendation, "call_json", changes_while_generating)
    assert client.post(url, json={"consent": True, "snapshot": snapshot}).status_code == 409
