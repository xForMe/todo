"""Candidate admission, confirmation, source withdrawal and verified citations."""

import json
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from database_support import test_database as database_for_test
from fastapi.testclient import TestClient
from sqlalchemy import event, insert, select, text, update
from sqlalchemy.exc import SQLAlchemyError
from test_memory import app_of, body, module

from todo_backend.integrations.ai.client import MemoryDraft, MemoryRef, Proposal, Proposals
from todo_backend.main import create_app
from todo_backend.modules.memory import candidates as candidate_service
from todo_backend.modules.memory.basis import verified_refs
from todo_backend.modules.memory.repository import candidates, cards, jobs, origins, suggestion_refs
from todo_backend.modules.memory.retrieval import memory_context
from todo_backend.modules.sources import recognition
from todo_backend.modules.sources import worker as source_worker
from todo_backend.modules.sources.discarding import discard_message
from todo_backend.modules.sources.repository import sources, suggestions
from todo_backend.modules.work.repository import items


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("TODO_DATABASE_URL", database_for_test(tmp_path / "candidates.db"))
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "1")
    command.upgrade(Config("alembic.ini"), "head")
    with TestClient(create_app(), base_url="http://127.0.0.1") as result:
        result.get("/api/session", headers={"X-Todo-Client": "web"})
        yield result


def setup_source(client: TestClient, mid: str, context: str = "") -> tuple[str, str, MemoryDraft]:
    evidence = "A项目模块负责客户实施和验收，简称华东一期。"
    raw = "当前页完整\n" + json.dumps(
        [{"message_id": "message-1", "text": evidence}], ensure_ascii=False
    )
    sid = str(uuid4())
    payload = {
        "id": sid,
        "kind": "document" if context else "chat",
        "address": "https://example.feishu.cn/docx/memory" if context else "oc_candidates",
        "enabled": True,
        "consent": True,
        "ai_consent": True,
        "interval": 900,
    }
    if context:
        payload["context"] = context
        raw = evidence
    response = client.post("/api/sources", json=payload)
    assert response.status_code == 200, response.text
    with app_of(client).state.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content=raw))
    draft = MemoryDraft(
        module_id=mid,
        kind="alias",
        aliases=["华东一期"],
        evidence=evidence,
        reason="明确给出模块职责与项目简称",
    )
    return sid, raw, draft


def generate(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str, str]:
    mid = module(client)
    sid, _, draft = setup_source(client, mid)
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(suggestions=[], memory_candidates=[draft]),
    )
    recognition.analyze_source(app_of(client).state.engine, sid)
    results = client.get("/api/memory/candidates").json()["items"]
    assert len(results) == 1
    return mid, sid, str(results[0]["id"])


def confirmation(client: TestClient, mid: str, cid: str) -> dict[str, object]:
    return {**body(client, mid, "客户实施和验收"), "candidate_id": cid}


def test_automatic_candidate_needs_confirmation_and_is_replay_safe(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    engine = app_of(client).state.engine
    assert memory_context(engine, "personal", "华东一期").text == ""
    with engine.connect() as conn:
        assert conn.execute(select(cards)).first() is None
        version = conn.execute(select(sources.c.version)).scalar_one()
    recognition.analyze_source(engine, sid, "message-1", version)
    assert len(client.get("/api/memory/candidates").json()["items"]) == 1
    payload = confirmation(client, mid, cid)
    response = client.put(f"/api/memory/modules/{mid}", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["usable"] is True
    assert client.put(f"/api/memory/modules/{mid}", json=payload).json() == response.json()
    assert "客户实施和验收" in memory_context(engine, "personal", "华东一期").text
    assert client.get("/api/memory/candidates").json()["items"] == []
    with engine.connect() as conn:
        assert len(conn.execute(select(origins)).all()) == 1
        assert conn.execute(text("SELECT COUNT(*) FROM memory_vectors")).scalar_one() == 0


def test_rejection_does_not_reappear_or_keep_raw_body(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    url = f"/api/memory/candidates/{cid}/reject"
    assert client.post(url).json() == {"state": "rejected"}
    assert client.post(url).json() == {"state": "rejected"}
    recognition.analyze_source(app_of(client).state.engine, sid, "message-1", 1)
    assert client.get("/api/memory/candidates").json()["items"] == []
    with app_of(client).state.engine.connect() as conn:
        assert conn.execute(select(candidates.c.body)).scalar_one() == ""
        assert conn.execute(select(cards)).first() is None
    assert (
        client.put(f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid)).status_code
        == 409
    )


def test_withdrawal_redacts_candidates_and_confirmed_card_and_receipt(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    payload = confirmation(client, mid, cid)
    assert client.put(f"/api/memory/modules/{mid}", json=payload).status_code == 200
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(enabled=False, version=2))
    card = client.get(f"/api/memory/modules/{mid}").json()["card"]
    assert not card["usable"] and card["description"] == "" and card["aliases"] == []
    assert memory_context(engine, "personal", "华东一期").text == ""
    receipt = client.get("/api/memory/operations/" + str(payload["operation_id"])).json()
    assert receipt["description"] == "" and receipt["usable"] is False
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(enabled=True, version=3))
    assert client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"] is False


def test_stale_candidate_conflict_keeps_card_unchanged_and_is_account_scoped(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    payload = confirmation(client, mid, cid)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid, "人工独立职责"))
    assert client.put(f"/api/memory/modules/{mid}", json=payload).status_code == 409
    with app_of(client).state.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(ai_consent=False, version=2))
    result = client.get("/api/memory/candidates").json()["items"][0]
    assert not result["usable"] and result["draft"] is None and result["current"] is None
    assert (
        client.put(f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid)).status_code
        == 409
    )
    monkeypatch.setenv("TODO_OWNER_ID", "another")
    assert client.get("/api/memory/candidates").json()["items"] == []
    assert client.post(f"/api/memory/candidates/{cid}/reject").status_code == 404


def test_page_changes_prevent_pending_confirmation_but_not_confirmed_facts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    payload = confirmation(client, mid, cid)
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        original = conn.execute(select(sources.c.content)).scalar_one()
        conn.execute(update(sources).where(sources.c.id == sid).values(content="当前页完整\n[]"))
    assert client.put(f"/api/memory/modules/{mid}", json=payload).status_code == 409
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content=original))
    assert client.put(f"/api/memory/modules/{mid}", json=payload).status_code == 200
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content="当前页完整\n[]"))
    assert client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"] is True


def test_discard_physically_purges_candidate_and_cannot_resurrect(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    client.put(f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid))
    engine = app_of(client).state.engine
    discard_message(engine, "personal", sid, "message-1", 1)
    assert memory_context(engine, "personal", "华东一期").text == ""
    with engine.connect() as conn:
        assert conn.execute(select(candidates.c.body)).scalar_one() == ""
        assert conn.execute(select(candidates.c.state)).scalar_one() == "invalid"


def test_false_evidence_alias_and_document_cross_scope_are_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid = module(client)
    other = module(client, "其他项目")
    sid, _, draft = setup_source(client, mid)
    drafts = [
        draft.model_copy(update={"evidence": "并不存在的原文依据"}),
        draft.model_copy(update={"aliases": ["编造简称"]}),
        draft.model_copy(update={"module_id": other}),
    ]
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(suggestions=[], memory_candidates=drafts),
    )
    recognition.analyze_source(app_of(client).state.engine, sid)
    assert client.get("/api/memory/candidates").json()["items"] == []
    thing = client.post(
        "/api/items",
        json={"operation_id": str(uuid4()), "type": "thing", "parent": mid, "name": "文档归属"},
    ).json()["id"]
    with app_of(client).state.engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(enabled=False))
    doc, _, _ = setup_source(client, mid, thing)
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(
            suggestions=[], memory_candidates=[draft.model_copy(update={"module_id": other})]
        ),
    )
    recognition.analyze_source(app_of(client).state.engine, doc)
    assert client.get("/api/memory/candidates").json()["items"] == []


def test_capacity_drops_new_candidates_without_blocking_action_recognition(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(candidate_service, "MAX_CANDIDATES", 0)
    mid = module(client)
    sid, _, draft = setup_source(client, mid)
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(suggestions=[], memory_candidates=[draft]),
    )
    engine = app_of(client).state.engine
    recognition.analyze_source(engine, sid)
    with engine.connect() as conn:
        assert conn.execute(select(candidates)).first() is None
        assert "候选容量已满" in conn.execute(select(sources.c.status)).scalar_one()
        assert conn.execute(select(sources.c.ai_hash)).scalar_one()


def test_only_explicit_supplied_citations_are_recorded(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    sid, _, draft = setup_source(client, mid)
    proposal = Proposal(
        action="new",
        thing_id="",
        module_id=mid,
        name="新行动",
        evidence=draft.evidence,
        memory_refs=[MemoryRef(module_id=mid, revision=1)],
    )
    monkeypatch.setattr(
        recognition, "recognize", lambda content, context: Proposals(suggestions=[proposal])
    )
    engine = app_of(client).state.engine
    recognition.analyze_source(engine, sid)
    with engine.connect() as conn:
        suggestion_id = conn.execute(select(suggestions.c.id)).scalar_one()
        assert len(conn.execute(select(suggestion_refs)).all()) == 1
    basis = client.get(f"/api/memory/suggestions/{suggestion_id}/basis").json()["items"]
    assert basis[0]["valid"] is True
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid, "已更新的职责"))
    basis = client.get(f"/api/memory/suggestions/{suggestion_id}/basis").json()["items"]
    assert basis[0]["valid"] is False and basis[0]["description"] == ""
    assert verified_refs(proposal, "", "无模块记忆") == []
    attached = json.dumps({"module_id": mid, "revision": 2})
    assert verified_refs(proposal, attached, attached) == []


def test_confirming_another_fact_keeps_existing_source_dependencies(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mid = module(client)
    sid, _, draft = setup_source(client, mid)
    profile = draft.model_copy(
        update={
            "kind": "module_profile",
            "description": "负责客户实施和验收",
            "aliases": [],
        }
    )
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(suggestions=[], memory_candidates=[draft, profile]),
    )
    engine = app_of(client).state.engine
    recognition.analyze_source(engine, sid)
    rows = client.get("/api/memory/candidates").json()["items"]
    assert len(rows) == 2
    for row in rows:
        response = client.put(
            f"/api/memory/modules/{mid}", json=confirmation(client, mid, row["id"])
        )
        assert response.status_code == 200, response.text
    with engine.connect() as conn:
        assert len(conn.execute(select(origins)).all()) == 2


def test_reference_capacity_keeps_actions_but_reports_missing_trace(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from todo_backend.modules.memory import basis

    monkeypatch.setattr(basis, "MAX_REFERENCES", 0)
    mid = module(client)
    client.put(f"/api/memory/modules/{mid}", json=body(client, mid))
    sid, _, draft = setup_source(client, mid)
    proposal = Proposal(
        action="new",
        thing_id="",
        module_id=mid,
        name="待确认行动",
        evidence=draft.evidence,
        memory_refs=[MemoryRef(module_id=mid, revision=1)],
    )
    monkeypatch.setattr(
        recognition, "recognize", lambda content, context: Proposals(suggestions=[proposal])
    )
    engine = app_of(client).state.engine
    recognition.analyze_source(engine, sid)
    with engine.connect() as conn:
        assert conn.execute(select(suggestion_refs)).first() is None
        saved = Proposal.model_validate_json(conn.execute(select(suggestions.c.body)).scalar_one())
        assert saved.name == "待确认行动" and saved.memory_refs == []
        assert "记忆引用容量已满" in conn.execute(select(sources.c.status)).scalar_one()


@pytest.mark.parametrize("accepted", [False, True])
@pytest.mark.parametrize("memory_enabled", ["0", "1"])
def test_observed_message_edit_cannot_revive_after_paging_or_restoration(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, accepted: bool, memory_enabled: str
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    payload = confirmation(client, mid, cid)
    if accepted:
        assert client.put(f"/api/memory/modules/{mid}", json=payload).status_code == 200
    engine = app_of(client).state.engine
    with engine.connect() as conn:
        original = conn.execute(select(sources.c.content)).scalar_one()
    monkeypatch.setenv("TODO_MEMORY_ENABLED", memory_enabled)
    monkeypatch.setattr(source_worker, "analyze_source", lambda *args: None)
    for content in (original.replace("客户实施", "不再实施"), "当前页完整\n[]", original):
        monkeypatch.setattr(source_worker, "read_source", lambda *args, value=content: value)
        with engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.id == sid).values(next_run=0))
        source_worker.poll_sources(engine)
        with engine.connect() as conn:
            row = conn.execute(select(candidates)).mappings().one()
            assert row["state"] == "invalid" and row["body"] == ""
            assert conn.execute(select(sources.c.content)).scalar_one() == content
    monkeypatch.setenv("TODO_MEMORY_ENABLED", "1")
    assert client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"] is False
    assert client.get("/api/memory/candidates").json()["items"] == []
    assert memory_context(engine, "personal", "华东一期").text == ""
    if accepted:
        receipt = client.get("/api/memory/operations/" + str(payload["operation_id"])).json()
        assert receipt["description"] == "" and not receipt["usable"]


@pytest.mark.parametrize("card_state", ["valid", "disabled", "scope_changed"])
def test_only_usable_aliases_can_ground_a_new_candidate(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, card_state: str
) -> None:
    mid = module(client)
    data = body(client, mid)
    if card_state == "disabled":
        data["enabled"] = False
    assert client.put(f"/api/memory/modules/{mid}", json=data).status_code == 200
    engine = app_of(client).state.engine
    if card_state == "scope_changed":
        with engine.begin() as conn:
            conn.execute(update(items).where(items.c.id == mid).values(name="新版模块"))
    sid, raw, draft = setup_source(client, mid)
    evidence = "华东一期负责客户实施和验收，简称东区。"
    with engine.begin() as conn:
        conn.execute(
            update(sources)
            .where(sources.c.id == sid)
            .values(content=raw.replace(draft.evidence, evidence))
        )
    draft = draft.model_copy(update={"evidence": evidence, "aliases": ["东区"]})
    monkeypatch.setattr(
        recognition,
        "recognize",
        lambda content, context: Proposals(suggestions=[], memory_candidates=[draft]),
    )
    recognition.analyze_source(engine, sid)
    assert len(client.get("/api/memory/candidates").json()["items"]) == (
        1 if card_state == "valid" else 0
    )


@pytest.mark.parametrize("fail_deletion", [False, True])
def test_edit_atomically_invalidates_only_dependent_indexes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fail_deletion: bool
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    assert (
        client.put(f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid)).status_code
        == 200
    )
    other = module(client, "独立手工模块")
    assert client.put(f"/api/memory/modules/{other}", json=body(client, other)).status_code == 200
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        original = conn.execute(select(sources.c.content)).scalar_one()
        for account, module_id in (("personal", mid), ("personal", other), ("other", mid)):
            conn.execute(
                insert(jobs).values(
                    account=account,
                    id=str(uuid4()),
                    module_id=module_id,
                    revision=1,
                    profile="test",
                    state="running",
                    started=1,
                )
            )
            value = "CAST(:v AS public.vector)" if conn.dialect.name == "postgresql" else ":v"
            conn.execute(
                text("INSERT INTO memory_vectors VALUES (:a,:m,1,'test'," + value + ")"),
                {"a": account, "m": module_id, "v": "[1,0,0]"},
            )
    monkeypatch.setattr(
        source_worker, "read_source", lambda *args: original.replace("客户实施", "不再实施")
    )
    monkeypatch.setattr(source_worker, "analyze_source", lambda *args: None)

    def reject_delete(
        conn: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        if statement.startswith("DELETE FROM memory_vectors"):
            raise SQLAlchemyError("injected storage failure")

    if fail_deletion:
        event.listen(engine, "before_cursor_execute", reject_delete)
        try:
            with pytest.raises(SQLAlchemyError):
                source_worker.poll_sources(engine)
        finally:
            event.remove(engine, "before_cursor_execute", reject_delete)
    else:
        source_worker.poll_sources(engine)
    with engine.connect() as conn:
        candidate = conn.execute(select(candidates)).mappings().one()
        if fail_deletion:
            assert candidate["state"] == "accepted" and candidate["body"]
            assert conn.execute(select(sources.c.content)).scalar_one() == original
        else:
            assert candidate["state"] == "invalid" and not candidate["body"]
            assert conn.execute(select(sources.c.content)).scalar_one() != original
        expected = {("personal", other), ("other", mid)}
        if fail_deletion:
            expected.add(("personal", mid))
        assert set(conn.execute(text("SELECT account,module_id FROM memory_vectors"))) == expected
        assert set(conn.execute(select(jobs.c.account, jobs.c.module_id))) == expected
    assert client.get(f"/api/memory/modules/{other}").json()["card"]["usable"] is True


@pytest.mark.parametrize("change", ["page", "pause", "newer_snapshot", "previous_edit", "rejected"])
def test_polling_invalidation_preserves_paging_and_rejects_stale_reads(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    mid, sid, cid = generate(client, monkeypatch)
    if change == "rejected":
        assert client.post(f"/api/memory/candidates/{cid}/reject").status_code == 200
    else:
        assert (
            client.put(
                f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid)
            ).status_code
            == 200
        )
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        original = conn.execute(select(sources.c.content)).scalar_one()
        if change == "previous_edit":
            conn.execute(
                update(sources)
                .where(sources.c.id == sid)
                .values(content=original.replace("客户实施", "不再实施"))
            )

    def read(kind: str, address: str) -> str:
        if change in ("pause", "newer_snapshot"):
            with engine.begin() as conn:
                values = (
                    {"enabled": False, "version": 2}
                    if change == "pause"
                    else {"content": "当前页完整\n[]"}
                )
                conn.execute(update(sources).where(sources.c.id == sid).values(**values))
        return (
            "当前页完整\n[]"
            if change in ("page", "previous_edit")
            else original.replace("客户实施", "不再实施")
        )

    monkeypatch.setattr(source_worker, "read_source", read)
    monkeypatch.setattr(source_worker, "analyze_source", lambda *args: None)
    source_worker.poll_sources(engine)
    with engine.connect() as conn:
        state = conn.execute(select(candidates.c.state)).scalar_one()
        assert state == (
            "invalid"
            if change == "previous_edit"
            else "rejected"
            if change == "rejected"
            else "accepted"
        )
        if change == "pause":
            assert conn.execute(select(sources.c.content)).scalar_one() == original
        if change == "newer_snapshot":
            assert conn.execute(select(sources.c.content)).scalar_one() == "当前页完整\n[]"
    if change == "page":
        assert client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"] is True


@pytest.mark.parametrize("kind", ["document", "legacy"])
def test_nonpaged_evidence_change_requires_new_confirmation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    mid = module(client)
    context = ""
    if kind == "document":
        context = client.post(
            "/api/items",
            json={
                "operation_id": str(uuid4()),
                "type": "thing",
                "parent": mid,
                "name": "原始文档",
            },
        ).json()["id"]
    sid, _, draft = setup_source(client, mid, context)
    engine = app_of(client).state.engine
    with engine.begin() as conn:
        conn.execute(update(sources).where(sources.c.id == sid).values(content=draft.evidence))
    monkeypatch.setattr(
        recognition, "recognize", lambda *args: Proposals(suggestions=[], memory_candidates=[draft])
    )
    recognition.analyze_source(engine, sid)
    cid = client.get("/api/memory/candidates").json()["items"][0]["id"]
    assert (
        client.put(f"/api/memory/modules/{mid}", json=confirmation(client, mid, cid)).status_code
        == 200
    )
    monkeypatch.setattr(source_worker, "analyze_source", lambda *args: None)
    for snapshot in ("新的正文", draft.evidence):
        monkeypatch.setattr(source_worker, "read_source", lambda *args, value=snapshot: value)
        with engine.begin() as conn:
            conn.execute(update(sources).where(sources.c.id == sid).values(next_run=0))
        source_worker.poll_sources(engine)
        assert client.get(f"/api/memory/modules/{mid}").json()["card"]["usable"] is False
