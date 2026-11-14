"""Authenticated HTTP boundary for the manual work slice."""

import os
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from todo_backend.modules.work.attention import AttentionInput, save_attention
from todo_backend.modules.work.deletion import DeleteInput
from todo_backend.modules.work.priority_service import PriorityInput
from todo_backend.modules.work.repository import deletions, items, operations, read_item
from todo_backend.modules.work.schemas import ItemOutput, WriteInput
from todo_backend.modules.work.service import WorkError, write_item

router = APIRouter(prefix="/api")


def check_origin(request: Request) -> None:
    """Reject browser requests originating from another site."""
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site" or (
        origin and origin != str(request.base_url).rstrip("/")
    ):
        raise HTTPException(403, "仅允许本机页面访问")


@router.get("/session")
def session(request: Request) -> JSONResponse:
    """Issue an automatic HttpOnly session for the local browser."""
    check_origin(request)
    if request.headers.get("x-todo-client") != "web":
        raise HTTPException(403, "请通过应用页面访问")
    response = JSONResponse({"status": "ready"})
    response.set_cookie(
        "todo_session", request.app.state.session_secret, httponly=True, samesite="strict", path="/"
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def account(request: Request) -> str:
    """Authenticate the automatic local session, keeping ownership server-side."""
    check_origin(request)
    cookie = request.cookies.get("todo_session", "")
    if not secrets.compare_digest(cookie, request.app.state.session_secret):
        raise HTTPException(401, "会话已失效，请刷新页面")
    return os.environ.get("TODO_OWNER_ID", "personal")


Identity = Annotated[str, Depends(account)]


@router.get("/workbench")
def workbench_snapshot(request: Request, identity: Identity) -> dict[str, object]:
    """Return the authenticated account's global snapshot."""
    from todo_backend.modules.work.workbench import snapshot

    return snapshot(request.app.state.engine, identity)


@router.post("/items/{item_id}/attention", response_model=ItemOutput)
def attention_write(
    item_id: str, data: AttentionInput, request: Request, identity: Identity
) -> ItemOutput:
    """Persist an explicitly selected attention state."""
    try:
        return save_attention(request.app.state.engine, identity, item_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/items", response_model=list[ItemOutput])
def list_items(request: Request, identity: Identity) -> list[ItemOutput]:
    """List only the authenticated account's objects."""
    with request.app.state.engine.connect() as conn:
        rows = conn.execute(
            select(items).where(
                items.c.account == identity, items.c.id.not_in(select(deletions.c.item_id))
            )
        ).mappings()
        return [
            ItemOutput.model_validate({k: v for k, v in row.items() if k != "account"})
            for row in rows
        ]


@router.post("/items", response_model=ItemOutput)
def create_item(data: WriteInput, request: Request, identity: Identity) -> ItemOutput:
    """Create a scoped object using a client operation ID."""
    return mutate(request, identity, data)


@router.put("/items/{item_id}", response_model=ItemOutput)
def edit_item(item_id: str, data: WriteInput, request: Request, identity: Identity) -> ItemOutput:
    """Update a versioned object without moving its hierarchy."""
    return mutate(request, identity, data, item_id)


def mutate(
    request: Request, identity: str, data: WriteInput, item_id: str | None = None
) -> ItemOutput:
    """Translate safe business failures while retaining operation context."""
    try:
        return write_item(request.app.state.engine, identity, data, item_id)
    except WorkError as exc:
        raise HTTPException(
            exc.status, {"message": exc.message, "operation_id": str(data.operation_id)}
        ) from exc


@router.get("/operations/{operation_id}", response_model=ItemOutput)
def operation(operation_id: str, request: Request, identity: Identity) -> ItemOutput:
    """Resolve a mutation after a missing or uncertain response."""
    with request.app.state.engine.connect() as conn:
        target = conn.execute(
            select(operations.c.item_id).where(
                operations.c.account == identity, operations.c.id == operation_id
            )
        ).scalar_one_or_none()
        result = read_item(conn, identity, target) if target else None
    if result is None:
        raise HTTPException(404, "未找到已提交操作，请核对输入后再手动保存")
    return result


async def database_error(request: Request, exc: Exception) -> JSONResponse:
    """Keep database internals out of error responses."""
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=503, content={"detail": "数据库暂不可用，请核对迁移状态"})


@router.get("/items/{item_id}/deletion")
def deletion_preview(item_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Read the impact of an explicitly selected deletion."""
    from todo_backend.modules.work.deletion import preview

    try:
        with request.app.state.engine.connect() as conn:
            return preview(conn, identity, item_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{item_id}/deletion")
def delete_work(
    item_id: str, data: DeleteInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Apply a reviewed deletion and transfer in one transaction."""
    from todo_backend.modules.work.deletion import remove_item

    try:
        return remove_item(request.app.state.engine, identity, item_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/deletions/{operation_id}")
def deletion_receipt(operation_id: str, request: Request, identity: Identity) -> dict[str, object]:
    """Resolve an uncertain deletion without resubmitting it."""
    from todo_backend.modules.work.deletion import receipt

    try:
        return receipt(request.app.state.engine, identity, operation_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/priorities")
def priority_overview(request: Request, identity: Identity) -> dict[str, object]:
    """Read weekly priority indicators for the current account."""
    from todo_backend.modules.work.priority_repository import overview

    with request.app.state.engine.connect() as conn:
        return overview(conn, identity)


@router.post("/items/{item_id}/priority", response_model=ItemOutput)
def priority_write(
    item_id: str, data: PriorityInput, request: Request, identity: Identity
) -> ItemOutput:
    """Save an explicitly reviewed priority mutation."""
    from todo_backend.modules.work.priority_service import save_priority

    try:
        return save_priority(request.app.state.engine, identity, item_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
