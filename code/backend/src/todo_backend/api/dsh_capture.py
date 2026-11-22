"""To Do MCP discovery, Host-approved event operations, and historical Web review."""

import hmac
import os
import re
import secrets
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import ClientDisconnect
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from todo_backend.api.work import Identity
from todo_backend.modules import dsh_capture, dsh_capture_review, dsh_direct, dsh_event_lookup
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api/dsh-captures")
TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}")
_APPROVAL = re.compile(r"v1=[a-f0-9]{64}")
_CREATE_DOMAIN = b"todo-direct-create-v1\n"
_COMPLETE_DOMAIN = b"todo-direct-complete-v1\n"
_MAX_DIRECT_BODY = 64 * 1024
_NO_STORE = {"Cache-Control": "no-store"}


def _is_native(peer: tuple[str, int] | None, headers: Headers, *, write: bool = False) -> bool:
    return bool(
        peer
        and peer[0] in {"127.0.0.1", "::1"}
        and not any(
            name in {"origin", "forwarded", "x-real-ip", "sec-fetch-site"}
            or name.startswith("x-forwarded-")
            # Node's fetch adds Sec-Fetch-Mode even for native MCP read requests.
            or (write and name.startswith("sec-fetch-"))
            for name in headers
        )
    )


async def _approved_body(request: Request, domain: bytes) -> bytes:
    """Verify a Host approval signature over the exact operation and body."""
    token = os.environ.get("TODO_DSH_DIRECT_TOKEN", "")
    capture = os.environ.get("TODO_DSH_CAPTURE_TOKEN", "")
    if not TOKEN.fullmatch(token) or hmac.compare_digest(token.encode(), capture.encode()):
        raise HTTPException(404, "会话直接录入未启用", headers=_NO_STORE)
    headers = request.headers
    if not _is_native(request.scope.get("client"), headers, write=True):
        raise HTTPException(403, "仅允许本机 Host 调用", headers=_NO_STORE)
    approvals = headers.getlist("x-todo-approval")
    if len(approvals) != 1 or not _APPROVAL.fullmatch(approvals[0]) or "authorization" in headers:
        raise HTTPException(401, "审批签名无效", headers=_NO_STORE)
    if headers.getlist("content-type") != ["application/json"] or "content-encoding" in headers:
        raise HTTPException(415, "请求须为 UTF-8 JSON", headers=_NO_STORE)
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > _MAX_DIRECT_BODY:
                raise HTTPException(413, "请求内容过长", headers=_NO_STORE)
            body.extend(chunk)
    except ClientDisconnect as exc:
        raise HTTPException(400, "请求未完整收到", headers=_NO_STORE) from exc
    exact = bytes(body)
    expected = hmac.new(token.encode(), domain + exact, "sha256").hexdigest()
    if not hmac.compare_digest(approvals[0], f"v1={expected}"):
        raise HTTPException(401, "审批签名无效", headers=_NO_STORE)
    return exact


async def record_event(request: Request, response: Response) -> dsh_direct.DirectReceipt:
    """Create one event using an approved, exactly signed request."""
    body = await _approved_body(request, _CREATE_DOMAIN)
    try:
        data = dsh_direct.DirectInput.model_validate_json(body, strict=True)
    except ValidationError as exc:
        raise HTTPException(422, "录入字段无效", headers=_NO_STORE) from exc
    try:
        result = await run_in_threadpool(
            dsh_direct.record,
            request.app.state.engine,
            os.environ.get("TODO_OWNER_ID", "personal"),
            data,
        )
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers=_NO_STORE) from exc
    response.headers.update(_NO_STORE)
    return result


async def finish_event(request: Request, response: Response) -> dsh_direct.CompletionReceipt:
    """Complete one event using the same approval gate as creation."""
    body = await _approved_body(request, _COMPLETE_DOMAIN)
    try:
        data = dsh_direct.CompletionInput.model_validate_json(body, strict=True)
    except ValidationError as exc:
        raise HTTPException(422, "完成事件的字段无效", headers=_NO_STORE) from exc
    try:
        result = await run_in_threadpool(
            dsh_direct.complete,
            request.app.state.engine,
            os.environ.get("TODO_OWNER_ID", "personal"),
            data,
        )
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message, headers=_NO_STORE) from exc
    response.headers.update(_NO_STORE)
    return result


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
        elif not _is_native(peer, headers):
            response = Response(status_code=403)
        elif len(headers.getlist("authorization")) != 1 or not secrets.compare_digest(
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
    lookup_enabled = dsh_event_lookup.enabled()
    server = FastMCP(
        "To Do Capture",
        instructions=(
            "用 find_matters 查找 To Do 事情及完整归属。"
            + ("用 locate_event 按用户提供的进展或线索查找已有事件。" if lookup_enabled else "")
            + "目标不明确时先请用户选择，不猜测。"
            "新建事件和将已有事件标为已完成，使用可用的 Harness Host 批准工具"
            " todo_create_event 或 todo_complete_event，由用户核对并批准本次操作。"
            "结果不明时用 get_recorded_event 查询原操作，不重新提交。"
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
    async def find_matters(query: str) -> str:
        """Find active matters by exact ID or path text; never select or write for the user."""
        try:
            result = await run_in_threadpool(
                dsh_direct.find_matters,
                app.state.engine,
                os.environ.get("TODO_OWNER_ID", "personal"),
                query,
            )
        except WorkError as exc:
            raise ToolError(exc.message) from exc
        return result.model_dump_json()

    @server.tool(structured_output=False)
    async def get_recorded_event(operation_id: str) -> str:
        """Read a Host-approved creation or completion by its original operation UUID."""
        try:
            identifier = UUID(operation_id)
            result = await run_in_threadpool(
                dsh_direct.receipt,
                app.state.engine,
                os.environ.get("TODO_OWNER_ID", "personal"),
                identifier,
            )
        except ValueError as exc:
            raise ToolError("操作标识格式无效") from exc
        except WorkError as exc:
            raise ToolError(exc.message) from exc
        return result.model_dump_json()

    @server.tool(structured_output=False)
    async def get_event_to_complete(event_id: str) -> str:
        """Verify the title, path and version of an already selected open event."""
        try:
            identifier = UUID(event_id)
            result = await run_in_threadpool(
                dsh_direct.preview_completion,
                app.state.engine,
                os.environ.get("TODO_OWNER_ID", "personal"),
                identifier,
            )
        except ValueError as exc:
            raise ToolError("事件标识格式无效") from exc
        except WorkError as exc:
            raise ToolError(exc.message) from exc
        return result.model_dump_json()

    if lookup_enabled:

        @server.tool(structured_output=False)
        async def locate_event(content: str, scope_hint: str = "") -> str:
            """Read event candidates for user-supplied progress; never update an event.

            Use only the current user's text. Supply scope_hint only for a project,
            module or matter name/path provided by the user. If the candidates are
            missing or inconclusive, ask for a clue instead of widening the search.
            """
            try:
                result = await run_in_threadpool(
                    dsh_event_lookup.locate,
                    app.state.engine,
                    os.environ.get("TODO_OWNER_ID", "personal"),
                    content,
                    scope_hint,
                )
            except WorkError as exc:
                raise ToolError(exc.message) from exc
            return result.model_dump_json()

    app.add_api_route("/api/dsh-direct/events", record_event, methods=["POST"])
    app.add_api_route("/api/dsh-direct/events/complete", finish_event, methods=["POST"])
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
