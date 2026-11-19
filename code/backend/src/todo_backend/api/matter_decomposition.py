"""Authenticated matter planning and prompt settings endpoints."""

from fastapi import APIRouter, HTTPException, Request

from todo_backend.api.work import Identity
from todo_backend.modules.matter_decomposition import generation, repository, service
from todo_backend.modules.matter_decomposition.schemas import (
    ConfirmInput,
    GenerateInput,
    TypeOutput,
    TypeWrite,
)
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api")


@router.get("/decomposition/types")
def types(request: Request, identity: Identity) -> list[TypeOutput]:
    """Read the account's visible defaults and overrides."""
    with request.app.state.engine.connect() as conn:
        return repository.list_types(conn, identity)


@router.put("/decomposition/types/{type_id}")
def save_type(
    type_id: str, data: TypeWrite, request: Request, identity: Identity
) -> dict[str, object]:
    """Save only the authenticated account's prompt policy."""
    try:
        return service.save_type(request.app.state.engine, identity, type_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/matters/{matter_id}/decomposition")
def context(matter_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Read the snapshot before generation or manual confirmation."""
    try:
        with request.app.state.engine.begin() as conn:
            service.begin_write(conn)
            return service.context(conn, identity, matter_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/matters/{matter_id}/decomposition")
def generate(
    matter_id: str, data: GenerateInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Generate without executing the proposed actions."""
    try:
        return generation.generate(request.app.state.engine, identity, matter_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/matters/{matter_id}/decomposition/confirm")
def confirm(
    matter_id: str, data: ConfirmInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Commit an explicitly confirmed batch."""
    try:
        return service.confirm(request.app.state.engine, identity, matter_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
