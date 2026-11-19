"""Bound multipart requests before spooling and sanitize credential validation errors."""

from fastapi import HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class ImageBodyLimit:
    """Limit the entire multipart body, including chunked requests and headers."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap image upload requests only."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Stop parsing once a request exceeds its bounded allowance."""
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or not scope["path"].startswith(("/api/events/", "/api/items/"))
            or not scope["path"].endswith("/images")
        ):
            await self.app(scope, receive, send)
            return
        total = 0

        async def limited_receive() -> Message:
            nonlocal total
            message = await receive()
            total += len(message.get("body", b""))
            if total > 11 * 1024 * 1024:
                raise HTTPException(413, "图片上传请求过大")
            return message

        await self.app(scope, limited_receive, send)


async def safe_validation(request: Request, exc: Exception) -> Response:
    """Avoid reflecting a rejected credential request's raw input."""
    if request.url.path.startswith("/api/image-storage"):
        return JSONResponse({"detail": "图片存储配置格式无效，请检查输入"}, status_code=422)
    if request.url.path.startswith(("/api/model-settings", "/api/model-catalog")):
        return JSONResponse({"detail": "大模型配置格式无效，请检查输入"}, status_code=422)
    if isinstance(exc, RequestValidationError):
        return await request_validation_exception_handler(request, exc)
    raise exc
