"""Validated uploads, explicit reconciliation and scoped attachment lifecycle."""

import hashlib
import io
import json
import warnings
from datetime import UTC, datetime
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from sqlalchemy import func, insert, select, update
from sqlalchemy.engine import Connection, Engine

from todo_backend.modules.images.configuration import fingerprint, operation, storage
from todo_backend.modules.images.repository import images, receipts, settings
from todo_backend.modules.images.schemas import RemoveInput
from todo_backend.modules.work.repository import items, read_item
from todo_backend.modules.work.schemas import ItemOutput
from todo_backend.modules.work.service import WorkError

MAX_BYTES = 10 * 1024 * 1024


def image_target(
    conn: Connection, account: str, event_id: str, version: int | None = None
) -> ItemOutput:
    """Check event scope, deletion and optional optimistic version."""
    row = read_item(conn, account, event_id)
    if row is None or row.type not in {"event", "thing"}:
        raise WorkError(404, "事情或事件不存在或无权访问")
    if version is not None and row.version != version:
        raise WorkError(409, "工作内容已变化，请刷新后操作图片")
    return row


def validate_image(data: bytes) -> str:
    """Decode real bounded static pictures, rejecting spoofed or dangerous files."""
    if not data or len(data) > MAX_BYTES:
        raise WorkError(422, "图片为空或超过10MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as picture:
                fmt = picture.format
                if fmt not in {"JPEG", "PNG", "WEBP"} or getattr(picture, "n_frames", 1) != 1:
                    raise WorkError(422, "只支持静态JPEG、PNG、WebP图片")
                if picture.width * picture.height > 25_000_000:
                    raise WorkError(422, "图片像素超过2500万")
                picture.verify()
            with Image.open(io.BytesIO(data)) as picture:
                picture.load()
        return {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}[str(fmt)]
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise WorkError(422, "图片损坏或无法安全读取") from exc


def attachment(conn: Connection, account: str, event_id: str, image_id: str) -> dict[str, object]:
    """Read one scoped attachment without exposing a cloud object key."""
    image_target(conn, account, event_id)
    row = (
        conn.execute(
            select(images).where(
                images.c.account == account, images.c.event_id == event_id, images.c.id == image_id
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise WorkError(404, "图片记录不存在")
    return dict(row)


def output(row: dict[str, object]) -> dict[str, object]:
    """Expose safe lifecycle metadata without profiles or internal object keys."""
    return {
        key: row[key] for key in ("id", "name", "mime", "size", "state", "created_at", "revision")
    }


def ready_images(
    conn: Connection, account: str, item_id: str, image_ids: list[str], *, lock: bool = False
) -> list[dict[str, object]]:
    """Resolve only ready images explicitly selected from the current object."""
    if len(set(image_ids)) != len(image_ids):
        raise WorkError(422, "图片不能重复选择")
    query = (
        select(images)
        .where(
            images.c.account == account,
            images.c.event_id == item_id,
            images.c.id.in_(image_ids),
            images.c.state == "ready",
        )
        .order_by(images.c.id)
    )
    if lock:
        query = query.with_for_update()
    rows = {str(row["id"]): dict(row) for row in conn.execute(query).mappings()}
    if len(rows) != len(image_ids):
        raise WorkError(409, "部分图片已移除、尚未保存或不属于当前对象")
    return [rows[key] for key in image_ids]


def list_images(conn: Connection, account: str, event_id: str) -> dict[str, object]:
    """List all visible reservations so interrupted uploads remain recoverable."""
    current = image_target(conn, account, event_id)
    rows = (
        conn.execute(
            select(images)
            .where(
                images.c.account == account,
                images.c.event_id == event_id,
                images.c.state != "removed",
            )
            .order_by(images.c.created_at, images.c.id)
        )
        .mappings()
        .all()
    )
    result = []
    for record in rows:
        row = dict(record)
        value = output(row)
        if row["state"] == "ready":
            value["url"] = storage(conn, account, str(row["profile_id"])).url(
                str(row["object_key"])
            )
        result.append(value)
    return {"event": current.model_dump(mode="json"), "images": result}


def reserve(
    engine: Engine,
    account: str,
    event_id: str,
    op: str,
    version: int,
    name: str,
    data: bytes,
    mime: str,
) -> bool:
    """Reserve capacity and a unique key before attempting any external write."""
    sha = hashlib.sha256(data).hexdigest()
    fp = fingerprint([event_id, version, name, sha])
    with engine.begin() as conn:
        if engine.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        conn.execute(
            select(items.c.id)
            .where(items.c.id == event_id, items.c.account == account)
            .with_for_update()
        ).first()
        image_target(conn, account, event_id, version)
        prior = conn.execute(select(images).where(images.c.id == op)).mappings().first()
        if prior:
            if prior["account"] != account or prior["fingerprint"] != fp:
                raise WorkError(409, "操作标识已用于其他图片或内容")
            return False
        profile = conn.execute(
            select(settings.c.profile_id).where(settings.c.account == account)
        ).scalar_one_or_none()
        if not profile:
            raise WorkError(409, "请先在设置中保存图片存储配置")
        count = conn.execute(
            select(func.count())
            .select_from(images)
            .where(
                images.c.account == account,
                images.c.event_id == event_id,
                images.c.state != "removed",
            )
        ).scalar_one()
        if count >= 20:
            raise WorkError(409, "每个对象最多20张图片，待核对上传也占用名额")
        conn.execute(
            insert(images).values(
                id=op,
                account=account,
                event_id=event_id,
                profile_id=profile,
                event_version=version,
                fingerprint=fp,
                object_key=f"todo-images/{hashlib.sha256(account.encode()).hexdigest()[:24]}/{event_id}/{uuid4()}",
                name=name,
                mime=mime,
                size=len(data),
                sha256=sha,
                state="pending",
                revision=1,
                created_at=datetime.now(UTC).isoformat(),
            )
        )
    return True


def matches(head: dict[str, object], row: dict[str, object]) -> bool:
    """Check server-reported length, MIME and the application digest metadata."""
    headers = {key.lower(): str(value) for key, value in head.items()}
    return (
        headers.get("content-length") == str(row["size"])
        and headers.get("x-cos-meta-sha256") == row["sha256"]
        and headers.get("content-type", "").split(";")[0] == row["mime"]
    )


def transfer(
    engine: Engine, account: str, event_id: str, op: str, data: bytes | None = None
) -> dict[str, object]:
    """Serialize per-upload writes/reconciliation; never retry an uncertain PUT."""
    with engine.begin() as conn:
        if engine.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        record = (
            conn.execute(
                select(images)
                .where(
                    images.c.account == account, images.c.id == op, images.c.event_id == event_id
                )
                .with_for_update()
            )
            .mappings()
            .first()
        )
        if not record:
            raise WorkError(404, "图片操作不存在")
        row = dict(record)
        image_target(conn, account, event_id)
        if row["state"] in {"ready", "removed"}:
            return output(row)
        if data is not None and row["state"] not in {"pending", "absent"}:
            return output(row)
        current = image_target(conn, account, event_id)
        if current.version != int(str(row["event_version"])):
            row.update(state="blocked", revision=int(str(row["revision"])) + 1)
            conn.execute(
                update(images)
                .where(images.c.id == op)
                .values(state=row["state"], revision=row["revision"])
            )
            return output(row)
        client = storage(conn, account, str(row["profile_id"]))
        state = "unknown"
        try:
            if data is not None:
                client.put(str(row["object_key"]), data, str(row["mime"]), str(row["sha256"]))
            head = client.head(str(row["object_key"]))
            state = "absent" if head is None else "ready" if matches(head, row) else "mismatch"
            image_target(conn, account, event_id, int(str(row["event_version"])))
        except WorkError:
            # Keep the reservation for a separate explicit reconciliation, not a second PUT.
            state = "unknown"
        conn.execute(
            update(images)
            .where(images.c.id == op)
            .values(state=state, revision=int(str(row["revision"])) + 1)
        )
    with engine.connect() as conn:
        return output(attachment(conn, account, event_id, op))


def upload(
    engine: Engine, account: str, event_id: str, op: str, version: int, name: str, data: bytes
) -> dict[str, object]:
    """Validate, reserve and send one user-authorized image."""
    mime = validate_image(data)
    safe_name = name.replace("\\", "/").rsplit("/", 1)[-1][:255] or "图片"
    fresh = reserve(engine, account, event_id, op, version, safe_name, data, mime)
    if not fresh:
        with engine.connect() as conn:
            row = attachment(conn, account, event_id, op)
            if row["state"] != "absent":
                return output(row)
    return transfer(engine, account, event_id, op, data)


def remove(
    engine: Engine, account: str, event_id: str, image_id: str, data: RemoveInput
) -> dict[str, object]:
    """Remove only the business association and verify the committed receipt."""
    op = str(data.operation_id)
    fp = fingerprint(["remove", event_id, image_id, data.expected_revision])
    with engine.begin() as conn:
        row = attachment(conn, account, event_id, image_id)
        prior = (
            conn.execute(select(receipts).where(receipts.c.account == account, receipts.c.id == op))
            .mappings()
            .first()
        )
        if prior:
            if prior["fingerprint"] != fp:
                raise WorkError(409, "操作标识已用于其他内容")
        else:
            if (
                row["state"] not in {"ready", "absent", "blocked"}
                or row["revision"] != data.expected_revision
            ):
                raise WorkError(409, "请先核对图片状态后再移除")
            changed = conn.execute(
                update(images)
                .where(images.c.id == image_id, images.c.revision == data.expected_revision)
                .values(state="removed", revision=data.expected_revision + 1)
            )
            if changed.rowcount != 1:
                raise WorkError(409, "图片已变化，请重新加载")
            result = output(attachment(conn, account, event_id, image_id))
            conn.execute(
                insert(receipts).values(
                    account=account, id=op, fingerprint=fp, result=json.dumps(result)
                )
            )
    with engine.connect() as conn:
        return operation(conn, account, op)
