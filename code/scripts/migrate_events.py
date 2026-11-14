"""Back up and verify existing table content around the 0007 migration."""

import hashlib
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from alembic import command
from alembic.config import Config


def digest(connection: sqlite3.Connection, table: str) -> tuple[int, str]:
    """Hash typed rows without printing any business content."""
    safe = table.replace('"', '""')
    rows = connection.execute(f'SELECT * FROM "{safe}"').fetchall()
    data = json.dumps(sorted(rows, key=repr), ensure_ascii=False, default=str)
    return len(rows), hashlib.sha256(data.encode()).hexdigest()


def main() -> None:
    """Back up a stopped local database, migrate and verify unchanged tables."""
    root = Path(__file__).resolve().parents[1] / "backend"
    db = root / "data" / "todo.sqlite3"
    configured = os.environ.get("TODO_DATABASE_URL")
    if configured and configured != "sqlite:///" + db.as_posix():
        raise RuntimeError("此脚本只允许迁移默认本地 SQLite")
    folder = db.parent / "backups" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-events")
    folder.mkdir(parents=True, exist_ok=False)
    with sqlite3.connect(db) as conn:
        with sqlite3.connect(folder / "todo.sqlite3") as copy:
            conn.backup(copy)
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
            if r[0] != "alembic_version"
        ]
        before = {table: digest(conn, table) for table in tables}
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    command.upgrade(config, "head")
    with sqlite3.connect(db) as conn:
        after = {table: digest(conn, table) for table in tables}
        assert before == after, "Existing table contents changed"
        revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    report = {
        "backup": str(folder / "todo.sqlite3"),
        "revision": revision,
        "preserved": before == after,
        "tables": before,
    }
    (folder / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "backup": report["backup"],
                "revision": revision,
                "preserved_tables": len(tables),
                "work_items": before["work_items"][0],
            }
        )
    )


if __name__ == "__main__":
    main()
