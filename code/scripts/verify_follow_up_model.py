"""Explicit synthetic model verification without accessing real business records."""

import json
import os
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from todo_backend.main import create_app


def main() -> None:
    """Verify a real model postponement and negation using synthetic local data."""
    if os.environ.get("TODO_VERIFY_REAL_MODEL") != "1":
        raise RuntimeError("Explicit TODO_VERIFY_REAL_MODEL=1 required")
    with TemporaryDirectory(prefix="todo-follow-up-model-") as folder:
        os.environ["TODO_DATABASE_URL"] = "sqlite:///" + (Path(folder) / "check.db").as_posix()
        os.environ["TODO_SOURCE_READER"] = "0"
        os.environ["TODO_MEMORY_ENABLED"] = "0"
        command.upgrade(Config("alembic.ini"), "head")
        with TestClient(create_app(), base_url="http://127.0.0.1") as client:
            client.get("/api/session", headers={"X-Todo-Client": "web"})
            parent = None
            today = date.fromisoformat(client.get("/api/workbench").json()["today"])
            for kind in ("goal", "module", "thing", "event"):
                payload = dict(
                    operation_id=str(uuid4()),
                    type=kind,
                    parent=parent,
                    name="合成验证-数据核对" if kind == "event" else "合成验证-" + kind,
                )
                if kind == "event":
                    payload["planEnd"] = (today + timedelta(days=2)).isoformat()
                response = client.post("/api/items", json=payload)
                response.raise_for_status()
                parent = response.json()["id"]
            url = f"/api/items/{parent}/daily-follow-ups"
            target = (today + timedelta(days=5)).isoformat()
            results = []
            for text, expected in [
                (f"因为合成数据尚未补齐，当前数据核对的完成时间变更到{target}。", target),
                ("今天收到一部分合成数据，不需要延期，仍按原计划推进。", target),
            ]:
                view = client.get(url).json()
                body = dict(
                    operation_id=str(uuid4()),
                    expected_version=view["item"]["version"],
                    expected_revision=view["revision"],
                    day=view["day"],
                    content=text,
                )
                response = client.post(url, json=body)
                response.raise_for_status()
                result = response.json()
                assert result["new_end"] == expected
                assert client.get(url).json()["item"]["planEnd"] == expected
                results.append(
                    dict(date_changed=result["old_end"] != result["new_end"], note=result["note"])
                )
            assert results[0]["date_changed"] is True
            assert results[1]["date_changed"] is False
            history = client.get(f"/api/items/{parent}/plan-history").json()
            assert len(history["records"]) == 1
            report = {
                "passed": True,
                "cases": results,
                "records": 2,
                "plan_changes": 1,
                "scope": "synthetic temporary SQLite only; real configured model",
            }
            output = Path("../../runtime/daily-follow-up-model.json")
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
