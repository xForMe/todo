"""Authenticated HTTP endpoints for private image storage and attachments."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile

from todo_backend.api.work import Identity
from todo_backend.modules.images import actions, configuration, model_settings, service
from todo_backend.modules.images.schemas import RemoveInput, StorageInput
from todo_backend.modules.work.service import WorkError

router = APIRouter(prefix="/api")


@router.get("/model-settings")
def get_model_settings(
    request: Request, response: Response, identity: Identity
) -> dict[str, object]:
    """Return the active model ID and safe credential status."""
    response.headers["Cache-Control"] = "private, no-store"
    with request.app.state.engine.connect() as conn:
        return model_settings.read(conn, identity)


@router.put("/model-settings")
def save_model_settings(
    data: model_settings.ModelSettingsInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Save one explicit model configuration change."""
    try:
        return model_settings.save(request.app.state.engine, identity, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/model-settings/operations/{operation_id}")
def model_settings_receipt(
    operation_id: UUID, request: Request, identity: Identity
) -> dict[str, object]:
    """Read the result of a model settings write without repeating it."""
    try:
        with request.app.state.engine.connect() as conn:
            return model_settings.receipt(conn, identity, str(operation_id))
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/model-settings/check")
def check_model_settings(request: Request, identity: Identity) -> dict[str, str]:
    """Look up the saved model in the provider directory."""
    try:
        return model_settings.check(request.app.state.engine, identity)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{item_id}/image-actions")
def analyze_images(
    item_id: str, data: actions.AnalyzeInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Generate a reviewable batch without creating any events."""
    try:
        return actions.analyze(request.app.state.engine, identity, item_id, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{item_id}/image-actions/{run_id}/confirm")
def confirm_images(
    item_id: str, run_id: UUID, data: actions.ConfirmInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Confirm edits in one scoped analysis batch."""
    try:
        return actions.confirm(request.app.state.engine, identity, item_id, str(run_id), data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/items/{item_id}/image-actions/{run_id}/result")
def confirm_result(
    item_id: str, run_id: UUID, request: Request, identity: Identity
) -> dict[str, object]:
    """Look up a confirmation without creating events again."""
    try:
        return actions.result(request.app.state.engine, identity, item_id, str(run_id))
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/image-storage")
def get_settings(request: Request, response: Response, identity: Identity) -> dict[str, object]:
    """Read safe fields only; do not cache credential status."""
    response.headers["Cache-Control"] = "private, no-store"
    with request.app.state.engine.connect() as conn:
        return configuration.read_config(conn, identity)


@router.put("/image-storage")
def save_settings(data: StorageInput, request: Request, identity: Identity) -> dict[str, object]:
    """Save an explicitly submitted complete configuration."""
    try:
        return configuration.save_config(request.app.state.engine, identity, data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/image-storage/check")
def check_settings(request: Request, identity: Identity) -> dict[str, object]:
    """Only check bucket reachability and HEAD permission, never write objects."""
    try:
        with request.app.state.engine.connect() as conn:
            configuration.storage(conn, identity).check()
        return {"message": "存储桶访问检查通过；尚未验证图片上传与下载权限"}
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/image-operations/{operation_id}")
def get_receipt(operation_id: UUID, request: Request, identity: Identity) -> dict[str, object]:
    """Reconcile a configuration or removal without repeating the write."""
    try:
        with request.app.state.engine.connect() as conn:
            return configuration.operation(conn, identity, str(operation_id))
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/items/{event_id}/images")
@router.get("/events/{event_id}/images")
def get_images(
    event_id: str, request: Request, response: Response, identity: Identity
) -> dict[str, object]:
    """Authorize before listing or signing private images."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        with request.app.state.engine.connect() as conn:
            result = service.list_images(conn, identity, event_id)
            source = actions.origin(conn, identity, event_id)
            if source:
                result["source"] = source
            return result
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{event_id}/images")
@router.post("/events/{event_id}/images")
def upload_image(
    event_id: str,
    request: Request,
    identity: Identity,
    operation_id: Annotated[UUID, Form()],
    expected_version: Annotated[int, Form(ge=1)],
    file: Annotated[UploadFile, File()],
) -> dict[str, object]:
    """Read a bounded file and delegate all side effects to the service."""
    try:
        with file.file:
            data = file.file.read(service.MAX_BYTES + 1)
        return service.upload(
            request.app.state.engine,
            identity,
            event_id,
            str(operation_id),
            expected_version,
            file.filename or "图片",
            data,
        )
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{event_id}/images/{image_id}/reconcile")
@router.post("/events/{event_id}/images/{image_id}/reconcile")
def reconcile_image(
    event_id: str, image_id: UUID, request: Request, identity: Identity
) -> dict[str, object]:
    """HEAD the reserved key under its upload lock; do not issue PUT."""
    try:
        return service.transfer(request.app.state.engine, identity, event_id, str(image_id))
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/items/{event_id}/images/{image_id}/remove")
@router.post("/events/{event_id}/images/{image_id}/remove")
def remove_image(
    event_id: str, image_id: UUID, data: RemoveInput, request: Request, identity: Identity
) -> dict[str, object]:
    """Remove a confirmed association; cloud bytes remain intact."""
    try:
        return service.remove(request.app.state.engine, identity, event_id, str(image_id), data)
    except WorkError as exc:
        raise HTTPException(exc.status, exc.message) from exc
