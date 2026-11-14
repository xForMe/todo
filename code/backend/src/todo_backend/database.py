"""Database configuration with no import-time connection."""

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import URL, Engine

from todo_backend.config import load_local_config


def database_url() -> str:
    """Resolve durable SQLite storage independently of working directory."""
    load_local_config()
    if os.environ.get("TODO_DATABASE_URL"):
        return os.environ["TODO_DATABASE_URL"]
    if os.environ.get("TODO_DB_HOST"):
        password = os.environ.get("DB_PASSWORD")
        if not password:
            raise ValueError("PostgreSQL password is missing")
        return URL.create(
            "postgresql+psycopg",
            username=os.environ["TODO_DB_USER"],
            password=password,
            host=os.environ["TODO_DB_HOST"],
            port=int(os.environ.get("TODO_DB_PORT", "5432")),
            database=os.environ["TODO_DB_NAME"],
            query={
                "sslmode": os.environ.get("TODO_DB_SSLMODE", "require"),
                "connect_timeout": "10",
            },
        ).render_as_string(hide_password=False)
    path = Path(__file__).resolve().parents[2] / "data" / "todo.sqlite3"
    return os.environ.get("TODO_DATABASE_URL", "sqlite:///" + path.as_posix())


def build_engine(url: str) -> Engine:
    """Build a portable engine with SQLite foreign keys enabled."""
    engine = (
        create_engine(url, isolation_level="SERIALIZABLE", pool_pre_ping=True, hide_parameters=True)
        if url.startswith("postgresql")
        else create_engine(url)
    )
    if engine.dialect.name == "sqlite":

        @event.listens_for(engine, "connect")
        def foreign_keys(connection: object, record: object) -> None:
            """Enable relational constraints on every pooled connection."""
            from sqlite3 import Connection

            if isinstance(connection, Connection):
                connection.execute("PRAGMA foreign_keys=ON")

    return engine
