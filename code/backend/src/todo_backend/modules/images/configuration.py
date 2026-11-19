"""Versioned account storage configuration with encrypted credentials."""

import hashlib
import json
import os
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine

from todo_backend.integrations.cos import Storage
from todo_backend.modules.images.repository import profiles, receipts, settings
from todo_backend.modules.images.schemas import StorageInput
from todo_backend.modules.work.service import WorkError


def cipher() -> Fernet:
    """Require a stable administrator-provided master key, never fall back to plaintext."""
    try:
        return Fernet(os.environ.get("TODO_STORAGE_ENCRYPTION_KEY", "").encode())
    except ValueError as exc:
        raise WorkError(503, "图片存储加密尚未初始化，请联系管理员") from exc


def fingerprint(value: object) -> str:
    """Hash replay arguments rather than storing plaintext secrets in receipts."""
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def validate_pair(secret_id: str, secret_key: str) -> None:
    """Reject an identifier pasted into both fields without disclosing either value."""
    if secret_id == secret_key:
        raise WorkError(422, "SecretId和SecretKey不能相同，请从腾讯云复制同一组密钥的两个不同字段")


def read_config(conn: Connection, account: str) -> dict[str, object]:
    """Return only non-secret configuration and a credential-presence flag."""
    row = (
        conn.execute(
            select(settings, profiles.c.region, profiles.c.bucket)
            .join(profiles, settings.c.profile_id == profiles.c.id)
            .where(settings.c.account == account)
        )
        .mappings()
        .first()
    )
    return {
        "region": row["region"] if row else "ap-shanghai",
        "bucket": row["bucket"] if row else "cc-1300161961",
        "revision": row["revision"] if row else 0,
        "has_credentials": bool(row),
    }


def operation(conn: Connection, account: str, op: str) -> dict[str, object]:
    """Read an immutable safe write receipt scoped to the current account."""
    row = conn.execute(
        select(receipts.c.result).where(receipts.c.account == account, receipts.c.id == op)
    ).scalar_one_or_none()
    if row is None:
        raise WorkError(404, "尚未查到操作结果，请继续核对")
    value: dict[str, object] = json.loads(row)
    return value


def save_config(engine: Engine, account: str, data: StorageInput) -> dict[str, object]:
    """Save complete credentials once; omitted credentials retain the current pair."""
    sid = data.secret_id.get_secret_value().strip() if data.secret_id else ""
    key = data.secret_key.get_secret_value().strip() if data.secret_key else ""
    if bool(sid) != bool(key) or len(sid) > 256 or len(key) > 256:
        raise WorkError(422, "请成对填写有效的SecretId和SecretKey")
    if sid:
        validate_pair(sid, key)
    fp = fingerprint(["config", data.expected_revision, data.region, data.bucket, sid, key])
    op = str(data.operation_id)
    with engine.begin() as conn:
        if engine.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        prior = (
            conn.execute(select(receipts).where(receipts.c.account == account, receipts.c.id == op))
            .mappings()
            .first()
        )
        if prior:
            if prior["fingerprint"] != fp:
                raise WorkError(409, "操作标识已用于其他配置")
        else:
            current = (
                conn.execute(
                    select(settings).where(settings.c.account == account).with_for_update()
                )
                .mappings()
                .first()
            )
            if (current["revision"] if current else 0) != data.expected_revision:
                raise WorkError(409, "配置已变化，请重新加载后保存")
            old = (
                conn.execute(select(profiles).where(profiles.c.id == current["profile_id"]))
                .mappings()
                .one()
                if current
                else None
            )
            same = old and old["region"] == data.region and old["bucket"] == data.bucket
            if not sid and not same:
                raise WorkError(422, "首次配置或切换存储位置时，请填写一组密钥")
            profile_id = str(old["id"]) if same and old else str(uuid4())
            encrypted = cipher().encrypt(json.dumps([sid, key]).encode()).decode() if sid else ""
            if same:
                if encrypted:
                    conn.execute(
                        update(profiles)
                        .where(profiles.c.id == profile_id)
                        .values(credentials=encrypted)
                    )
            else:
                conn.execute(
                    insert(profiles).values(
                        id=profile_id,
                        account=account,
                        region=data.region,
                        bucket=data.bucket,
                        credentials=encrypted,
                    )
                )
            values = {"profile_id": profile_id, "revision": data.expected_revision + 1}
            if current:
                conn.execute(update(settings).where(settings.c.account == account).values(**values))
            else:
                conn.execute(insert(settings).values(account=account, **values))
            result = read_config(conn, account)
            conn.execute(
                insert(receipts).values(
                    account=account, id=op, fingerprint=fp, result=json.dumps(result)
                )
            )
    with engine.connect() as conn:
        return operation(conn, account, op)


def storage(conn: Connection, account: str, profile_id: str = "") -> Storage:
    """Resolve the original profile for old pictures, independent of current settings."""
    if not profile_id:
        profile_id = str(
            conn.execute(
                select(settings.c.profile_id).where(settings.c.account == account)
            ).scalar_one_or_none()
            or ""
        )
    row = (
        conn.execute(
            select(profiles).where(profiles.c.account == account, profiles.c.id == profile_id)
        )
        .mappings()
        .first()
    )
    if not row:
        raise WorkError(409, "请先在设置中保存图片存储配置")
    try:
        sid, key = json.loads(cipher().decrypt(str(row["credentials"]).encode()))
    except InvalidToken as exc:
        raise WorkError(503, "存储凭据无法解密，请联系管理员") from exc
    validate_pair(sid, key)
    return Storage(str(row["region"]), str(row["bucket"]), sid, key)
