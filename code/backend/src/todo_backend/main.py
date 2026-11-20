"""Assemble the personal development application."""

import asyncio
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import Response
from starlette.types import Scope

from todo_backend.api.dsh_capture import attach_mcp
from todo_backend.api.dsh_capture import router as dsh_capture_router
from todo_backend.api.events import router as events_router
from todo_backend.api.health import router as health_router
from todo_backend.api.image_limits import ImageBodyLimit, safe_validation
from todo_backend.api.images import router as images_router
from todo_backend.api.matter_decomposition import router as matter_decomposition_router
from todo_backend.api.memory import router as memory_router
from todo_backend.api.model_catalog import router as model_catalog_router
from todo_backend.api.sources import router as sources_router
from todo_backend.api.work import database_error
from todo_backend.api.work import router as work_router
from todo_backend.config import load_local_config
from todo_backend.database import build_engine, database_url
from todo_backend.modules.sources.worker import run_reader


class FreshStaticFiles(StaticFiles):
    """Keep this local application's HTML and scripts on the same revision."""

    def is_not_modified(self, response_headers: Headers, request_headers: Headers) -> bool:
        """Do not reuse old bundles on conditional requests after a local upgrade."""
        return False

    async def get_response(self, path: str, scope: Scope) -> Response:
        """Prevent new stale copies of mutable local frontend assets."""
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


def create_app() -> FastAPI:
    """Create API and static frontend without implicit database migration."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        load_local_config()
        app.state.session_secret = secrets.token_urlsafe(32)
        app.state.engine = build_engine(database_url())
        stop = asyncio.Event()
        reader = (
            asyncio.create_task(run_reader(app.state.engine, stop))
            if os.environ.get("TODO_SOURCE_READER", "1") == "1"
            else None
        )
        try:
            async with mcp.session_manager.run():
                yield
        finally:
            stop.set()
            if reader is not None:
                await reader
            app.state.engine.dispose()

    app = FastAPI(title="To Do", version="0.2.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])
    app.add_middleware(ImageBodyLimit)
    app.include_router(health_router)
    app.include_router(images_router)
    app.include_router(model_catalog_router)
    app.include_router(work_router)
    app.include_router(events_router)
    app.include_router(matter_decomposition_router)
    app.include_router(sources_router)
    app.include_router(memory_router)
    app.include_router(dsh_capture_router)
    mcp = attach_mcp(app)
    app.add_exception_handler(SQLAlchemyError, database_error)
    app.add_exception_handler(RequestValidationError, safe_validation)
    frontend = Path(__file__).resolve().parents[3] / "frontend-react" / "public"
    app.mount("/", FreshStaticFiles(directory=frontend, html=True), name="frontend")
    return app
