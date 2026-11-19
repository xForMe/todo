"""Keep default tests offline and isolate explicitly requested remote runs."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from database_support import clean_schemas


@pytest.fixture(autouse=True)
def offline_defaults(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Prevent health-only tests or workers from reaching configured production data."""
    monkeypatch.setenv("TODO_DATABASE_URL", "sqlite:///" + (tmp_path / "default.db").as_posix())
    monkeypatch.setenv("TODO_SOURCE_READER", "0")
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "0")
    monkeypatch.setenv("TODO_EMBEDDING_CONSENT", "0")
    monkeypatch.setenv("TODO_EMBEDDING_SOURCE_CONSENT", "0")
    yield
    clean_schemas()
