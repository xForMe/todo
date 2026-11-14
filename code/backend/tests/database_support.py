"""Opt-in PostgreSQL verification in disposable schemas, never public tables."""

import os
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

SCHEMAS: list[tuple[str, str]] = []


def test_database(path: Path) -> str:
    """Create an isolated schema only when explicitly configured for verification."""
    base = os.environ.get("TODO_TEST_DATABASE_URL")
    if not base:
        return "sqlite:///" + path.as_posix()
    url = make_url(base)
    if url.get_backend_name() != "postgresql" or url.database != "todo":
        raise ValueError("Verification is restricted to PostgreSQL database todo")
    schema = "todo_validation_" + uuid4().hex
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine.dispose()
    SCHEMAS.append((base, schema))
    return url.update_query_dict({"options": f"-csearch_path={schema}"}).render_as_string(
        hide_password=False
    )


def clean_schemas() -> None:
    """Remove only schemas allocated by this test process after verification."""
    while SCHEMAS:
        base, schema = SCHEMAS.pop()
        assert schema.startswith("todo_validation_") and len(schema) == 48
        engine = create_engine(base)
        with engine.begin() as conn:
            conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        engine.dispose()
