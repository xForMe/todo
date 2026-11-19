"""Opt-in real model verification using only synthetic work in a temporary database."""

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from todo_backend.main import create_app


def main() -> None:
    """Exercise classification, prompt selection and confirmation without real business writes."""
    if os.environ.get("TODO_VERIFY_REAL_MODEL") != "1":
        raise RuntimeError("Set TODO_VERIFY_REAL_MODEL=1 for this explicit synthetic check")
    with TemporaryDirectory(prefix="todo-planning-model-") as folder:
        os.environ["TODO_DATABASE_URL"] = "sqlite:///" + (Path(folder) / "check.db").as_posix()
        os.environ["TODO_SOURCE_READER"] = "0"
        os.environ["TODO_MEMORY_ENABLED"] = "0"
        command.upgrade(Config("alembic.ini"), "head")
        with TestClient(create_app(), base_url="http://127.0.0.1") as client:
            client.get("/api/session", headers={"X-Todo-Client": "web"})
            parent = None
            for kind, name in [
                ("goal", "合成验证目标"),
                ("module", "示例模块"),
                ("thing", "示例设备告警功能研发与交付"),
            ]:
                response = client.post(
                    "/api/items",
                    json={
                        "operation_id": str(uuid4()),
                        "type": kind,
                        "parent": parent,
                        "name": name,
                    },
                )
                response.raise_for_status()
                parent = response.json()["id"]
            path = f"/api/matters/{parent}/decomposition"
            snapshot = client.get(path).json()["snapshot"]
            response = client.post(path, json={"snapshot": snapshot})
            response.raise_for_status()
            result = response.json()
            assert result["basis"]["type_id"] == "feature", "Unexpected synthetic classification"
            assert result["suggestions"], "No suggestions for the synthetic feature"
            assert len(client.get("/api/items").json()) == 3
            confirmation = {
                "operation_id": str(uuid4()),
                "snapshot": snapshot,
                "generation_id": result["generation_id"],
                "events": [
                    {"type": "event", "parent": parent, "name": result["suggestions"][0]["name"]},
                ],
            }
            created = client.post(path + "/confirm", json=confirmation)
            created.raise_for_status()
            assert client.post(path + "/confirm", json=confirmation).json() == created.json()
            print(
                json.dumps(
                    {
                        "passed": True,
                        "type": result["basis"]["type_id"],
                        "suggestions": len(result["suggestions"]),
                        "created": 1,
                        "real_business_writes": 0,
                    },
                    ensure_ascii=False,
                )
            )


if __name__ == "__main__":
    main()
