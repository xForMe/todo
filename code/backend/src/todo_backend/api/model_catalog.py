"""Authenticated endpoints for models and their scene assignments."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response

from todo_backend.api.work import Identity
from todo_backend.modules import model_catalog
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api/model-catalog")


@router.get("")
def read(request: Request, response: Response, identity: Identity) -> dict[str, object]:
    """Read the account catalog without exposing API keys."""
    response.headers["Cache-Control"] = "private, no-store"
    with request.app.state.engine.connect() as conn:
        return model_catalog.read(conn, identity)


@router.put("")
def save(data: model_catalog.SaveInput, request: Request, identity: Identity) -> dict[str, object]:
    """Save the full configuration once."""
    try:
        return model_catalog.save(request.app.state.engine, identity, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/operations/{operation_id}")
def receipt(
    operation_id: UUID, request: Request, response: Response, identity: Identity
) -> dict[str, object]:
    """Read a safe write receipt scoped to the current account."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        with request.app.state.engine.connect() as conn:
            return model_catalog.receipt(conn, identity, operation_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/{model_id}/check")
def check(model_id: UUID, request: Request, identity: Identity) -> dict[str, str]:
    """Check the model's provider directory on explicit request."""
    try:
        return model_catalog.check(request.app.state.engine, identity, model_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
