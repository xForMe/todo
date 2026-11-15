"""Check configured storage without printing its connection URL or changing schema."""

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.database import build_engine, database_url


def main() -> int:
    """Require configured PostgreSQL without silently falling back to an old local database."""
    try:
        engine = build_engine(database_url())
    except (KeyError, ValueError):
        print("PostgreSQL configuration is incomplete; verify the local environment file.")
        return 1
    try:
        if engine.dialect.name != "postgresql":
            print("Launcher requires PostgreSQL; SQLite fallback is disabled.")
            return 1
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
