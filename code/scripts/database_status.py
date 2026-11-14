"""Check configured storage without printing its connection URL or changing schema."""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.database import build_engine, database_url


def main() -> int:
    """Return a distinct result for local SQLite so the launcher can keep backups."""
    engine = build_engine(database_url())
    try:
        if engine.dialect.name == "sqlite":
            expected = Path(__file__).resolve().parents[1] / "backend" / "data" / "todo.sqlite3"
            if Path(engine.url.database or "").resolve() != expected.resolve():
                print("Custom SQLite requires the manual startup workflow.")
                return 1
            return 10
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        if version != ScriptDirectory.from_config(Config("alembic.ini")).get_current_head():
            print("Database schema is not current; run an explicit migration first.")
            return 1
        print("PostgreSQL connection and schema verified; no migration performed.")
        return 0
    except SQLAlchemyError:
        print("Database check failed; verify credentials, connectivity and migration state.")
        return 1
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
