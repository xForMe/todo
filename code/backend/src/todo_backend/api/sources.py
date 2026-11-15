"""Authenticated source management endpoints."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import select

from todo_backend.api.work import Identity
from todo_backend.integrations.ai.client import Proposal
from todo_backend.modules.sources.discarding import discard_message
from todo_backend.modules.sources.follow import RuleInput, list_rules, save_rule
from todo_backend.modules.sources.placement import Placement
from todo_backend.modules.sources.recognition import resolve_proposal
from todo_backend.modules.sources.recovery import manual_message, retry_message, unmatched_messages
from todo_backend.modules.sources.repository import read_sources, sources, suggestions
from todo_backend.modules.sources.schemas import SourceInput
from todo_backend.modules.sources.service import save_source
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api/sources")


class RetryMessage(BaseModel):
    """Explicit single-message recognition request."""

    source_id: str
    message_id: str
    expected_version: int


@router.get("/unmatched")
def list_unmatched(request: Request, identity: Identity) -> list[dict[str, object]]:
    """List stored messages without matching suggestion evidence."""
    return unmatched_messages(request.app.state.engine, identity)


@router.post("/discard-message")
def discard_recognition(data: RetryMessage, request: Request, identity: Identity) -> dict[str, str]:
    """Permanently ignore only the message explicitly selected by its owner."""
    try:
        return {
            "status": discard_message(
                request.app.state.engine,
                identity,
                data.source_id,
                data.message_id,
                data.expected_version,
            )
        }
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/retry-message")
def retry_recognition(data: RetryMessage, request: Request, identity: Identity) -> dict[str, str]:
    """Run one user-requested model call, never accept its suggestion automatically."""
    try:
        status = retry_message(
            request.app.state.engine,
            identity,
            data.source_id,
            data.message_id,
            data.expected_version,
        )
        return {"status": status}
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/manual-message")
def prepare_manual(data: RetryMessage, request: Request, identity: Identity) -> dict[str, str]:
    """Prepare a user-requested draft; formal work still needs confirmation."""
    try:
        return {
            "suggestion_id": manual_message(
                request.app.state.engine,
                identity,
                data.source_id,
                data.message_id,
                data.expected_version,
            )
        }
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("")
def list_sources(request: Request, identity: Identity) -> list[dict[str, object]]:
    """Read sources for the current local account."""
    with request.app.state.engine.connect() as conn:
        return read_sources(conn, identity)


@router.post("")
def write_source(data: SourceInput, request: Request, identity: Identity) -> dict[str, object]:
    """Apply an explicit source authorization or revision."""
    try:
        return save_source(request.app.state.engine, identity, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


class Decision(BaseModel):
    """Explicit user acceptance or rejection."""

    accept: bool
    edited: Proposal | None = None
    placement: Placement | None = None


@router.get("/suggestions")
def list_suggestions(request: Request, identity: Identity) -> list[dict[str, object]]:
    """Return pending suggestions and linked evidence in account scope."""
    with request.app.state.engine.connect() as conn:
        rows = conn.execute(
            select(suggestions, sources.c.kind.label("source_kind"))
            .outerjoin(
                sources, (sources.c.id == suggestions.c.source_id) & (sources.c.account == identity)
            )
            .where(
                suggestions.c.account == identity,
                suggestions.c.state.in_(["pending", "linked", "applying"]),
            )
        ).mappings()
        return [{str(k): v for k, v in r.items() if k != "account"} for r in rows]


@router.post("/suggestions/{suggestion_id}")
def decide_suggestion(
    suggestion_id: str, data: Decision, request: Request, identity: Identity
) -> dict[str, object]:
    """Resolve an explicit confirmation and return the read-back result."""
    try:
        result = resolve_proposal(
            request.app.state.engine,
            identity,
            suggestion_id,
            data.accept,
            data.edited,
            data.placement,
        )
        return {"saved": result.model_dump() if result else None}
    except ValidationError as exc:
        raise HTTPException(422, "建议字段或日期不合法，请修改后再确认") from exc
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/follow")
def get_follow(request: Request, identity: Identity) -> list[dict[str, object]]:
    """Read private reminder state for the authenticated owner."""
    return list_rules(request.app.state.engine, identity)


@router.post("/follow/{event_id}")
def put_follow(
    event_id: str, data: RuleInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Persist explicit event-specific sending consent."""
    try:
        return save_rule(request.app.state.engine, identity, event_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
