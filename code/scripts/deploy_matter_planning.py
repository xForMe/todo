"""Back up an additive planning/review migration and verify existing business rows."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Engine, make_url

from todo_backend.database import build_engine, database_url


def snapshot(engine: Engine) -> dict[str, dict[str, str | int]]:
    """Hash existing public records without exposing their contents."""
    result: dict[str, dict[str, str | int]] = {}
    with engine.connect() as conn:
        conn.execute(text("SET TRANSACTION READ ONLY"))
        names = (
            conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
            )
            .scalars()
            .all()
        )
        for name in names:
            if name == "alembic_version":
                continue
            quoted = conn.dialect.identifier_preparer.quote(name)
            rows = conn.execute(
                text(f"SELECT row_to_json(t)::text FROM public.{quoted} t")
            ).scalars()
            serialized = sorted(rows)
            result[name] = {
                "rows": len(serialized),
                "sha256": hashlib.sha256("\n".join(serialized).encode()).hexdigest(),
            }
    return result


def main() -> None:
    """Require an explicit apply flag and backup destination; do not stop processes here."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--revision",
        choices=("0015", "0016", "0017", "0018", "0019", "0020", "0022", "0023"),
        default="0015",
    )
    args = parser.parse_args()
    target = args.revision
    previous = f"{int(target) - 1:04}"
    expected_tables = {
        "0015": ["decomposition_runs", "decomposition_types"],
        "0016": ["action_review_operations", "action_reviews"],
        "0017": ["plan_baselines", "plan_changes"],
        "0018": ["action_followups"],
        "0019": [
            "event_images",
            "image_operations",
            "image_storage_profiles",
            "image_storage_settings",
        ],
        "0020": ["image_action_runs", "image_action_sources"],
        "0022": ["vision_settings", "vision_settings_operations"],
        "0023": ["model_catalog_operations", "model_catalogs"],
    }[target]
    if not args.apply:
        raise RuntimeError("Explicit --apply is required after stopping application writes")
    url = make_url(database_url())
    if url.get_backend_name() != "postgresql" or url.database != "todo":
        raise RuntimeError("Deployment is restricted to the configured todo PostgreSQL database")
    engine = build_engine(url.render_as_string(hide_password=False))
    try:
        with engine.connect() as conn:
            revision = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        if target == "0022" and revision == "0020":
            previous = "0020"
            expected_tables = ["event_predecessors", *expected_tables]
        if revision != previous:
            raise RuntimeError(f"Expected revision {previous}; no changes applied")
        dump = shutil.which("pg_dump")
        restore = shutil.which("pg_restore")
        if not dump or not restore:
            raise RuntimeError("PostgreSQL backup tools are required")
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
        before = snapshot(engine)
        (output / "before.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
        env = os.environ.copy()
        env.update(
            PGHOST=url.host or "",
            PGPORT=str(url.port or 5432),
            PGDATABASE=url.database or "",
            PGUSER=url.username or "",
            PGPASSWORD=url.password or "",
            PGSSLMODE=str(url.query.get("sslmode", "require")),
        )
        backup = output / f"before-{target}.dump"
        process = subprocess.run(
            [dump, "-Fc", "-f", str(backup)], env=env, capture_output=True, timeout=180, check=False
        )
        if process.returncode:
            raise RuntimeError("Backup failed; migration not applied")
        check = subprocess.run(
            [restore, "--list", str(backup)], capture_output=True, timeout=30, check=False
        )
        if check.returncode or not backup.stat().st_size:
            raise RuntimeError("Backup validation failed; migration not applied")
        command.upgrade(Config("alembic.ini"), target)
        with engine.connect() as conn:
            if conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() != target:
                raise RuntimeError("Migration revision readback failed")
        after = snapshot(engine)
        (output / "after.json").write_text(json.dumps(after, indent=2), encoding="utf-8")
        if any(after.get(key) != value for key, value in before.items()):
            raise RuntimeError("Existing data changed; inspect snapshots before starting service")
        new_tables = sorted(set(after) - set(before))
        if new_tables != expected_tables:
            raise RuntimeError("Unexpected new tables; inspect before starting service")
        result = {
            "revision": target,
            "existing_tables_unchanged": len(before),
            "existing_rows_unchanged": sum(int(v["rows"]) for v in before.values()),
            "new_tables": new_tables,
            "backup_bytes": backup.stat().st_size,
        }
        (output / "verification.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
