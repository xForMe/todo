"""Draft-only local MCP and authenticated Web capture review routes."""

import logging
import os
import re
import secrets
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from todo_backend.api.work import Identity
from todo_backend.modules import dsh_capture, dsh_capture_review
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api/dsh-captures")
TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}")
logger = logging.getLogger(__name__)


class LocalCapture:
    """Require a dedicated native-client token before the SDK receives the HTTP body."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the MCP SDK application only."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Reject unauthenticated and browser-origin requests before parsing."""
        token = os.environ.get("TODO_DSH_CAPTURE_TOKEN", "")
        headers = Headers(scope=scope)
        peer = scope.get("client")
        if not TOKEN.fullmatch(token):
            response = Response(status_code=404)
        elif (
            not peer
            or peer[0] not in {"127.0.0.1", "::1"}
            or "origin" in headers
            or "sec-fetch-site" in headers
            or any(name in headers for name in ("forwarded", "x-forwarded-for", "x-forwarded-host"))
        ):
            response = Response(status_code=403)
        elif not secrets.compare_digest(
            headers.get("authorization", "").encode("latin-1"), f"Bearer {token}".encode()
        ):
            response = Response(status_code=401, headers={"WWW-Authenticate": "Bearer"})
        else:

            async def no_store(message: Message) -> None:
                if message["type"] == "http.response.start":
                    MutableHeaders(scope=message)["Cache-Control"] = "no-store"
                await send(message)

            await self.app(scope, receive, no_store)
            return
        await response(scope, receive, send)


def attach_mcp(app: FastAPI) -> FastMCP:
    """Register the exact /mcp route before the frontend catch-all mount."""
    server = FastMCP(
        "To Do Capture",
        instructions=(
            "仅在用户主动要求录入时提交选定文本，不提交会话历史。"
            "生成结果是草稿，不能创建正式事件。一次操作使用一个 UUID，"
            "响应丢失后使用 get_capture 核对原操作，不自动重发。"
        ),
        json_response=True,
        stateless_http=True,
        max_request_body_size=64 * 1024,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[
                "127.0.0.1",
                "127.0.0.1:*",
                "localhost",
                "localhost:*",
                "[::1]",
                "[::1]:*",
            ]
        ),
    )

    @server.tool(structured_output=False)
    async def prepare_capture(operation_id: str, text: str) -> str:
        """Submit user-selected text (1–4000 chars) for a new-event draft only."""
        try:
            identifier = UUID(operation_id)
            result = await run_in_threadpool(
                dsh_capture.prepare,
                app.state.engine,
                os.environ.get("TODO_OWNER_ID", "personal"),
                identifier,
                text,
            )
        except ValueError as exc:
            raise ToolError("操作标识或输入格式无效") from exc
        except WorkError as exc:
            raise ToolError(exc.message) from exc
        except Exception as exc:
            logger.error("DSH capture prepare failed: %s", type(exc).__name__)
            raise ToolError("草稿结果待核对，请通过原操作标识查询，不要重复提交") from exc
        return result.model_dump_json()

    @server.tool(structured_output=False)
    async def get_capture(operation_id: str) -> str:
        """Read one draft by its original operation UUID without generating or writing."""
        try:
            identifier = UUID(operation_id)
            result = await run_in_threadpool(
                dsh_capture.read,
                app.state.engine,
                os.environ.get("TODO_OWNER_ID", "personal"),
                identifier,
            )
        except ValueError as exc:
            raise ToolError("操作标识格式无效") from exc
        except WorkError as exc:
            raise ToolError(exc.message) from exc
        except Exception as exc:
            logger.error("DSH capture read failed: %s", type(exc).__name__)
            raise ToolError("暂时无法核对草稿") from exc
        return result.model_dump_json()

    app.router.routes.append(Route("/mcp", LocalCapture(server.streamable_http_app())))
    return server


def _require_web_write(request: Request) -> None:
    expected_origin = str(request.base_url).rstrip("/")
    if (
        "authorization" in request.headers
        or request.headers.getlist("origin") != [expected_origin]
        or request.headers.getlist("x-todo-client") != ["web"]
        or request.headers.getlist("sec-fetch-site") not in ([], ["same-origin"])
    ):
        raise HTTPException(403, "请在 To Do 页面中确认保存")


@router.get("")
def list_drafts(
    request: Request,
    identity: Identity,
    response: Response,
    offset: Annotated[int, Query(ge=0, le=2_147_483_647)] = 0,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dsh_capture_review.DraftPage:
    """List current account's pending capture drafts without contacting a model."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return dsh_capture_review.list_pending(request.app.state.engine, identity, offset, limit)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers={"Cache-Control": "no-store"}) from exc


@router.get("/{capture_id}")
def get_draft(
    capture_id: UUID, request: Request, identity: Identity, response: Response
) -> dsh_capture.Draft:
    """Allow the existing local Web identity to read a known draft."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return dsh_capture.read(request.app.state.engine, identity, capture_id)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers={"Cache-Control": "no-store"}) from exc


@router.post("/{capture_id}/confirm", dependencies=[Depends(_require_web_write)])
def confirm_draft(
    capture_id: UUID,
    data: dsh_capture_review.ConfirmationInput,
    request: Request,
    identity: Identity,
    response: Response,
) -> dsh_capture_review.Confirmation:
    """Accept an explicit approval from the same-origin authenticated To Do page."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return dsh_capture_review.confirm(request.app.state.engine, identity, capture_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers={"Cache-Control": "no-store"}) from exc


@router.get("/{capture_id}/operations/{operation_id}")
def capture_receipt(
    capture_id: UUID, operation_id: UUID, request: Request, identity: Identity, response: Response
) -> dsh_capture_review.Confirmation:
    """Verify the exact prior confirmation; this route never retries a write."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return dsh_capture_review.receipt(
            request.app.state.engine, identity, capture_id, operation_id
        )
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers={"Cache-Control": "no-store"}) from exc
