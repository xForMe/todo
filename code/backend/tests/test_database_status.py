"""Launcher must reject SQLite before creating files or contacting storage."""

import runpy
from pathlib import Path
from typing import cast
from unittest.mock import Mock

import pytest

from todo_backend import database


def run_check() -> int:
    """Load the real launcher entry point without invoking its __main__ block."""
    path = Path(__file__).resolve().parents[2] / "scripts" / "database_status.py"
    namespace = runpy.run_path(str(path))
    result = namespace["main"]()
    return cast(int, result)


def test_sqlite_is_rejected_without_creating_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "old.sqlite3"
    monkeypatch.setattr(database, "database_url", lambda: "sqlite:///" + path.as_posix())
    assert run_check() == 1
    assert not path.exists()


def test_missing_postgresql_configuration_is_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing() -> str:
        raise ValueError("password is missing")

    monkeypatch.setattr(database, "database_url", missing)
    assert run_check() == 1


@pytest.mark.parametrize("revision,expected", [("0023", 0), ("0022", 1), ("0001", 1)])
def test_postgresql_checks_migration_revision(
    revision: str, expected: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = Mock()
    engine.dialect.name = "postgresql"
    engine.connect.return_value.__enter__ = Mock(return_value=engine)
    engine.connect.return_value.__exit__ = Mock(return_value=False)
    engine.execute.return_value.scalar_one.return_value = revision
    monkeypatch.setattr(database, "build_engine", lambda url: engine)
    monkeypatch.setattr(database, "database_url", lambda: "postgresql+psycopg://example")
    assert run_check() == expected
    engine.dispose.assert_called_once()
