import pytest
from sqlalchemy.engine import make_url

from todo_backend import database


def test_explicit_url_precedes_local_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(database, "load_local_config", lambda: None)
    monkeypatch.setenv("TODO_DATABASE_URL", "sqlite:///isolated.db")
    monkeypatch.setenv("TODO_DB_HOST", "unused")
    assert database.database_url() == "sqlite:///isolated.db"


def test_password_encoding_and_missing_password(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(database, "load_local_config", lambda: None)
    monkeypatch.delenv("TODO_DATABASE_URL", raising=False)
    monkeypatch.setenv("TODO_DB_HOST", "localhost")
    monkeypatch.setenv("TODO_DB_USER", "example")
    monkeypatch.setenv("TODO_DB_NAME", "example")
    monkeypatch.setenv("DB_PASSWORD", "test@:/%# secret")
    url = make_url(database.database_url())
    assert url.password == "test@:/%# secret"
    assert url.database == "example" and url.username == "example"
    monkeypatch.delenv("DB_PASSWORD")
    with pytest.raises(ValueError, match="password is missing"):
        database.database_url()
