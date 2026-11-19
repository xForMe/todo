"""Authenticated HTTP interface for explicitly confirmed module memory."""

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from todo_backend.api.work import Identity
from todo_backend.integrations.ai.embeddings import EmbeddingError, configuration
from todo_backend.modules.memory.basis import suggestion_basis
from todo_backend.modules.memory.candidates import list_candidates, reject_candidate
from todo_backend.modules.memory.indexing import index_card
from todo_backend.modules.memory.repository import jobs
from todo_backend.modules.memory.schemas import CardInput, CardOutput, IndexInput, WorkingOutput
from todo_backend.modules.memory.service import (
    enabled,
    operation_result,
    read_card,
    require_enabled,
    save_card,
)
from todo_backend.modules.memory.working import refresh_working
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api/memory")


@router.get("/candidates")
def get_candidates(request: Request, identity: Identity, module_id: str = "") -> dict[str, object]:
    """Review pending drafts without making another model request."""
    try:
        with request.app.state.engine.connect() as conn:
            return list_candidates(conn, identity, module_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/candidates/{candidate_id}/reject")
def reject(candidate_id: str, request: Request, identity: Identity) -> dict[str, str]:
    """Explicitly reject a candidate, safely repeatable without an external side effect."""
    try:
        return {"state": reject_candidate(request.app.state.engine, identity, candidate_id)}
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/suggestions/{suggestion_id}/basis")
def get_basis(suggestion_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Expose verified model-reported references, not an inferred reasoning trace."""
    try:
        with request.app.state.engine.connect() as conn:
            return suggestion_basis(conn, identity, suggestion_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/working/{thing_id}/refresh", response_model=WorkingOutput)
def refresh_summary(thing_id: str, request: Request, identity: Identity) -> WorkingOutput:
    """Rebuild current facts idempotently, without issuing any external request."""
    try:
        return refresh_working(request.app.state.engine, identity, thing_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/modules/{module_id}")
def get_card(module_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Expose current scope and safe indexing status without credentials."""
    try:
        require_enabled()
        try:
            profile = configuration().profile
            configured = True
        except EmbeddingError:
            profile = ""
            configured = False
        with request.app.state.engine.connect() as conn:
            card = read_card(conn, identity, module_id)
            latest = conn.execute(
                select(jobs.c.state)
                .where(
                    jobs.c.account == identity,
                    jobs.c.module_id == module_id,
                    jobs.c.revision == card.version,
                    jobs.c.profile == profile,
                )
                .order_by(jobs.c.started.desc(), jobs.c.id)
                .limit(1)
            ).scalar_one_or_none()
        return {
            "card": card.model_dump(),
            "index_state": (latest or "not_indexed") if card.usable else "not_indexed",
            "embedding_configured": configured,
            "enabled": enabled(),
        }
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.put("/modules/{module_id}", response_model=CardOutput)
def put_card(module_id: str, data: CardInput, request: Request, identity: Identity) -> CardOutput:
    """Confirm a new revision using a client operation ID."""
    try:
        return save_card(request.app.state.engine, identity, module_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/operations/{operation_id}", response_model=CardOutput)
def get_operation(operation_id: str, request: Request, identity: Identity) -> CardOutput:
    """Resolve an uncertain write without replaying it."""
    try:
        with request.app.state.engine.connect() as conn:
            return operation_result(conn, identity, operation_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/modules/{module_id}/index")
def post_index(
    module_id: str, data: IndexInput, request: Request, identity: Identity
) -> dict[str, str]:
    """Authorize a single indexing attempt; retries require another explicit action."""
    try:
        return {"state": index_card(request.app.state.engine, identity, module_id, data)}
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
