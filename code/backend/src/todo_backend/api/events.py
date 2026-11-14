"""Authenticated routes for event structure and optional AI generation."""

from fastapi import APIRouter, HTTPException, Request

from todo_backend.api.work import Identity
from todo_backend.modules.work import event_structure as service
from todo_backend.modules.work.decomposition import Candidates, GenerateInput, generate
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api")


@router.get("/events/{event_id}/structure")
def structure(event_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Return a scoped review snapshot."""
    try:
        with request.app.state.engine.connect() as conn:
            return service.state(conn, identity, event_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/events/{event_id}/children")
def change(
    event_id: str, data: service.EventAction, request: Request, identity: Identity
) -> dict[str, object]:
    """Apply one reviewed event structure operation."""
    try:
        return service.mutate(request.app.state.engine, identity, event_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/event-operations/{operation_id}")
def receipt(operation_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Resolve a potentially committed write without repeating it."""
    try:
        return service.receipt(request.app.state.engine, identity, operation_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/events/{event_id}/decomposition")
def decomposition(
    event_id: str, data: GenerateInput, request: Request, identity: Identity
) -> Candidates:
    """Generate candidates only after explicit context consent."""
    try:
        return generate(request.app.state.engine, identity, event_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
