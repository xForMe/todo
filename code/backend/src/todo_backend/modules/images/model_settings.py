"""Resolve and persist private, account-scoped image analysis settings."""

import hmac
import json
import os
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection, Engine, RowMapping

from todo_backend.integrations.ai import vision
from todo_backend.integrations.ai.client import AIError
from todo_backend.modules.images import configuration
from todo_backend.modules.images.repository import vision_receipts, vision_settings
from todo_backend.modules.work.service import WorkError


class ModelSettingsInput(BaseModel):
    """Accept a model ID and optional replacement key at an expected revision."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    operation_id: UUID
    expected_revision: int = Field(ge=0)
    model: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    api_key: SecretStr | None = Field(default=None, max_length=512)


def _cipher() -> Fernet:
    try:
        return configuration.cipher()
    except WorkError as exc:
        raise WorkError(503, "模型密钥加密尚未初始化，请联系管理员") from exc


def _row(conn: Connection, account: str, *, for_update: bool = False) -> RowMapping | None:
    query = select(vision_settings).where(vision_settings.c.account == account)
    if for_update:
        query = query.with_for_update()
    return conn.execute(query).mappings().one_or_none()


def _default_key() -> str:
    return (
        os.environ.get("TODO_VISION_API_KEY", "").strip()
        or os.environ.get("TODO_UAIAPI_KEY", "").strip()
    )


def _model(row: RowMapping | None) -> str:
    return str(row["model"]) if row else os.environ.get("TODO_VISION_MODEL", "").strip()


def read(conn: Connection, account: str) -> dict[str, object]:
    """Return the effective model and key status without requesting any key bytes."""
    row = _row(conn, account)
    source = "server" if _default_key() else "missing"
    if row and row["encrypted_key"]:
        source = "saved"
    return {"model": _model(row), "key_source": source, "revision": row["revision"] if row else 0}


def receipt(conn: Connection, account: str, operation_id: str) -> dict[str, object]:
    """Read an immutable result for an operation owned by the requesting account."""
    raw = conn.execute(
        select(vision_receipts.c.result).where(
            vision_receipts.c.account == account, vision_receipts.c.id == operation_id
        )
    ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "尚未查到保存结果")
    result: dict[str, object] = json.loads(raw)
    return result


def save(engine: Engine, account: str, data: ModelSettingsInput) -> dict[str, object]:
    """Persist one versioned change and verify it through an independent read."""
    key = data.api_key.get_secret_value().strip() if data.api_key else ""
    if key and (not key.isascii() or any(not ("!" <= char <= "~") for char in key)):
        raise WorkError(422, "请填写有效的 API Key")
    encrypted_key = _cipher().encrypt(key.encode()).decode() if key else ""
    # Keyed fingerprints permit replay matching without persisting a password hash.
    key_tag = (
        hmac.digest(
            os.environ["TODO_STORAGE_ENCRYPTION_KEY"].encode(), key.encode(), "sha256"
        ).hex()
        if key
        else ""
    )
    fingerprint = configuration.fingerprint([data.expected_revision, data.model, key_tag])
    operation_id = str(data.operation_id)
    with engine.begin() as conn:
        ensure_row = sqlite_insert if engine.dialect.name == "sqlite" else pg_insert
        conn.execute(
            ensure_row(vision_settings)
            .values(account=account, model="", encrypted_key="", revision=0)
            .on_conflict_do_nothing(index_elements=[vision_settings.c.account])
        )
        row = _row(conn, account, for_update=True)
        assert row is not None
        prior = conn.execute(
            select(vision_receipts.c.fingerprint).where(
                vision_receipts.c.account == account, vision_receipts.c.id == operation_id
            )
        ).scalar_one_or_none()
        if prior is not None:
            if prior != fingerprint:
                raise WorkError(409, "操作标识已用于其他配置")
        else:
            if row["revision"] != data.expected_revision:
                raise WorkError(409, "配置已在其他页面更新，请重新加载后保存")
            conn.execute(
                update(vision_settings)
                .where(vision_settings.c.account == account)
                .values(
                    model=data.model,
                    encrypted_key=encrypted_key or row["encrypted_key"],
                    revision=data.expected_revision + 1,
                )
            )
            conn.execute(
                insert(vision_receipts).values(
                    account=account,
                    id=operation_id,
                    fingerprint=fingerprint,
                    result=json.dumps(read(conn, account)),
                )
            )
    with engine.connect() as conn:
        return receipt(conn, account, operation_id)


def resolve(conn: Connection, account: str) -> tuple[str, str]:
    """Load the latest model and decrypt only the credential needed for a request."""
    row = _row(conn, account)
    model = _model(row)
    if not model:
        raise WorkError(503, "请先在「设置 → 大模型」中保存图片分析模型 ID")
    key = _default_key()
    if row and row["encrypted_key"]:
        try:
            key = _cipher().decrypt(str(row["encrypted_key"]).encode()).decode()
        except InvalidToken as exc:
            raise WorkError(503, "模型密钥无法解密，请重新保存 API Key") from exc
    if not key:
        raise WorkError(503, "请先在「设置 → 大模型」中保存 API Key")
    return model, key


def check(engine: Engine, account: str) -> dict[str, str]:
    """Check visibility in the gateway catalog using saved configuration."""
    with engine.connect() as conn:
        model, key = resolve(conn, account)
    try:
        if not vision.model_listed(model, key):
            raise WorkError(422, "模型目录中未找到该 ID，请核对模型名称和 API Key 的授权范围")
    except AIError as exc:
        raise WorkError(502, str(exc)) from exc
    return {"message": "模型已在 UAIAPI 目录中找到，图片分析能力需通过实际调用验证。"}
