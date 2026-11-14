"""Regression coverage for overlapping Feishu pages and durable processing."""

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from sqlalchemy import create_engine, event, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from todo_backend.integrations.ai.client import AIError, Proposal, Proposals
from todo_backend.modules.sources.message_receipts import receipts
from todo_backend.modules.sources.recognition import analyze_source
from todo_backend.modules.sources.repository import sources, suggestions


def page(*ids: str) -> str:
    return "当前页完整\n" + json.dumps(
        [{"message_id": mid, "content": "行动" + mid} for mid in ids], ensure_ascii=False
    )


def add_source(
    engine: Engine, content: str, account: str = "personal", chat: str = "oc_test"
) -> str:
    sid = str(uuid4())
    with engine.begin() as conn:
        conn.execute(
            insert(sources).values(
                id=sid,
                account=account,
                context="",
                kind="chat",
                address=chat,
                interval=300,
                enabled=True,
                removed=False,
                version=1,
                next_run=0,
                last_run=0,
                content=content,
                ai_consent=True,
                ai_hash="",
                status="",
            )
        )
    return sid


@pytest.fixture
def engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Engine:
    url = database_for_test(tmp_path / "messages.db")
    monkeypatch.setenv("TODO_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return create_engine(url)


@pytest.mark.parametrize("state", ["pending", "accepted", "rejected"])
def test_overlap_and_durable_identity(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    calls: list[str] = []

    def recognize(content: str, context: str) -> Proposals:
        calls.append(content)
        return Proposals(
            suggestions=[Proposal(action="new", thing_id="", name="行动", evidence=content)]
        )

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", recognize)
    sid = add_source(engine, page("a"))
    analyze_source(engine, sid)
    with engine.begin() as conn:
        conn.execute(update(suggestions).values(state=state))
        conn.execute(update(sources).values(content=page("b", "a", "b")))
    analyze_source(engine, sid)
    assert len(calls) == 2 and "行动a" not in calls[1]
    assert calls[1].count("行动b") == 1
    with engine.begin() as conn:
        conn.execute(update(sources).values(content=page("a", "b"), removed=True, enabled=False))
    # Recreated configuration and a fresh connection pool must retain processed identities.
    engine.dispose()
    new_sid = add_source(engine, page("a", "b"))
    analyze_source(engine, new_sid)
    assert len(calls) == 2
    with engine.connect() as conn:
        assert len(conn.execute(select(suggestions)).all()) == 2
        assert len(conn.execute(select(receipts)).all()) == 2
    analyze_source(engine, add_source(engine, page("a"), chat="oc_other"))
    analyze_source(engine, add_source(engine, page("a"), account="other"))
    assert len(calls) == 4


def test_failed_empty_and_stale_results(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    sid = add_source(engine, page("a"))

    def fail(content: str, context: str) -> Proposals:
        raise AIError("模型失败")

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", fail)
    analyze_source(engine, sid)
    with engine.begin() as conn:
        assert not conn.execute(select(receipts)).all()
        conn.execute(update(sources).values(enabled=True))

    def stale(content: str, context: str) -> Proposals:
        with engine.begin() as conn:
            conn.execute(update(sources).values(content=page("b")))
        return Proposals(suggestions=[])

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", stale)
    analyze_source(engine, sid)
    with engine.connect() as conn:
        assert not conn.execute(select(receipts)).all()
    monkeypatch.setattr(
        "todo_backend.modules.sources.recognition.recognize", lambda c, x: Proposals(suggestions=[])
    )
    analyze_source(engine, sid)
    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", fail)
    analyze_source(engine, sid)
    with engine.connect() as conn:
        assert conn.execute(select(receipts.c.message_id)).scalar_one() == "b"
        assert conn.execute(select(sources.c.enabled)).scalar_one()


def test_insert_failure_rolls_back_receipts(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    sid = add_source(engine, page("a"))
    monkeypatch.setattr(
        "todo_backend.modules.sources.recognition.recognize",
        lambda c, x: Proposals(
            suggestions=[Proposal(action="new", thing_id="", name="行动", evidence=c)]
        ),
    )

    def reject(
        conn: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        if statement.startswith("INSERT INTO source_suggestions"):
            raise IntegrityError(statement, None, RuntimeError("injected failure"))

    event.listen(engine, "before_cursor_execute", reject)
    with pytest.raises(IntegrityError):
        analyze_source(engine, sid)
    event.remove(engine, "before_cursor_execute", reject)
    with engine.connect() as conn:
        assert not conn.execute(select(receipts)).all()
        assert conn.execute(select(sources.c.ai_hash)).scalar_one() == ""
    analyze_source(engine, sid)
    with engine.connect() as conn:
        assert len(conn.execute(select(suggestions)).all()) == 1


def test_migration_seeds_only_proven_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = database_for_test(tmp_path / "upgrade.db")
    monkeypatch.setenv("TODO_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "0009")
    engine = create_engine(url)
    sid = add_source(engine, page("a"))
    add_source(engine, page("b"), chat="oc_failed")
    with engine.begin() as conn:
        conn.execute(
            update(sources)
            .where(sources.c.id == sid)
            .values(ai_hash=hashlib.sha256(page("a").encode()).hexdigest())
        )
    command.upgrade(Config("alembic.ini"), "head")
    with engine.connect() as conn:
        assert conn.execute(select(receipts.c.message_id)).scalars().all() == ["a"]


def test_overlapping_recognition_commits_once(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = add_source(engine, page("a"))
    second = add_source(engine, page("a"))
    nested = False

    def recognize(content: str, context: str) -> Proposals:
        nonlocal nested
        if not nested:
            nested = True
            analyze_source(engine, second)
        return Proposals(
            suggestions=[Proposal(action="new", thing_id="", name="行动", evidence=content)]
        )

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", recognize)
    analyze_source(engine, first)
    with engine.connect() as conn:
        assert len(conn.execute(select(suggestions)).all()) == 1
        assert len(conn.execute(select(receipts)).all()) == 1


def test_missing_identity_pauses_without_calling_model(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    sid = add_source(engine, '当前页完整\n[{"content":"缺少标识"}]')

    def unexpected(content: str, context: str) -> Proposals:
        pytest.fail("Malformed chat must never reach model")

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", unexpected)
    analyze_source(engine, sid)
    with engine.connect() as conn:
        assert not conn.execute(select(receipts)).all()
        assert not conn.execute(select(sources.c.enabled)).scalar_one()


def test_pause_during_model_does_not_mark_processed(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    sid = add_source(engine, page("a"))

    def pause(content: str, context: str) -> Proposals:
        with engine.begin() as conn:
            conn.execute(update(sources).values(enabled=False, version=2))
        return Proposals(suggestions=[])

    monkeypatch.setattr("todo_backend.modules.sources.recognition.recognize", pause)
    analyze_source(engine, sid)
    with engine.connect() as conn:
        assert not conn.execute(select(receipts)).all()
