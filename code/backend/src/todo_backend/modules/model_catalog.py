"""Account model profiles, scene assignments and versioned configuration writes."""

import hashlib
import hmac
import json
import os
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import Column, Integer, String, Table, Text, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection, Engine, RowMapping

from todo_backend.integrations.ai import vision
from todo_backend.integrations.ai.client import AIError
from todo_backend.integrations.ai.endpoint import ModelTarget, normalize_base_url
from todo_backend.modules.work.repository import metadata
from todo_backend.modules.work.service import WorkError

SCENES = {
    "image_analysis": "图片分析",
    "matter_decomposition": "事情拆解",
    "event_decomposition": "事件拆分",
    "event_predecessors": "前置推荐",
    "daily_follow_up": "当日跟进",
    "source_recognition": "飞书资料识别",
}

catalogs = Table(
    "model_catalogs",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("configuration", Text, nullable=False),
    Column("revision", Integer, nullable=False),
)
receipts = Table(
    "model_catalog_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("result", Text, nullable=False),
)


class Profile(BaseModel):
    """Share the non-secret model fields between input and persistence."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: UUID
    name: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    base_url: str = Field(min_length=1, max_length=500)
    vision: bool = False


class ProfileInput(Profile):
    """New credentials are write-only; omission retains the saved key at the same address."""

    api_key: SecretStr | None = Field(default=None, max_length=512)
    clear_key: bool = False


class StoredProfile(Profile):
    """A profile with a server-only encrypted credential."""

    encrypted_key: str = ""


class Catalog(BaseModel):
    """Persist the latest profiles and their validated references together."""

    models: list[StoredProfile] = Field(default_factory=list)
    assignments: dict[str, UUID] = Field(default_factory=dict)

    def find(self, model_id: UUID | None) -> StoredProfile | None:
        """Read an account profile by its stable ID."""
        return next((model for model in self.models if model.id == model_id), None)


class SaveInput(BaseModel):
    """Update the entire configuration against a specific revision."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision: int = Field(ge=0)
    models: list[ProfileInput] = Field(max_length=40)
    assignments: dict[str, UUID] = Field(max_length=len(SCENES))


def _row(conn: Connection, account: str, *, lock: bool = False) -> RowMapping | None:
    query = select(catalogs).where(catalogs.c.account == account)
    if lock:
        query = query.with_for_update()
    return conn.execute(query).mappings().one_or_none()


def _catalog(row: RowMapping | None) -> Catalog:
    return Catalog.model_validate_json(row["configuration"]) if row else Catalog()


def _view(catalog: Catalog, revision: int) -> dict[str, object]:
    return {
        "revision": revision,
        "models": [
            {
                **model.model_dump(mode="json", exclude={"encrypted_key"}),
                "has_key": bool(model.encrypted_key),
            }
            for model in catalog.models
        ],
        "assignments": {name: str(model_id) for name, model_id in catalog.assignments.items()},
        "scenes": SCENES,
    }


def read(conn: Connection, account: str) -> dict[str, object]:
    """Return catalogue fields and key-presence flags for the current account."""
    row = _row(conn, account)
    return _view(_catalog(row), row["revision"] if row else 0)


def receipt(conn: Connection, account: str, operation_id: UUID) -> dict[str, object]:
    """Recover a saved operation without repeating it."""
    raw = conn.execute(
        select(receipts.c.result).where(
            receipts.c.account == account, receipts.c.id == str(operation_id)
        )
    ).scalar_one_or_none()
    if raw is None:
        raise WorkError(404, "尚未查到保存结果")
    result: dict[str, object] = json.loads(raw)
    return result


def _cipher() -> Fernet:
    try:
        return Fernet(os.environ.get("TODO_STORAGE_ENCRYPTION_KEY", "").encode())
    except ValueError as exc:
        raise WorkError(503, "模型密钥加密尚未初始化") from exc


def _keys(data: SaveInput) -> dict[UUID, str]:
    keys: dict[UUID, str] = {}
    for profile in data.models:
        key = profile.api_key.get_secret_value().strip() if profile.api_key else ""
        if key and (profile.clear_key or any(not ("!" <= ch <= "~") for ch in key)):
            raise WorkError(422, "请填写有效的 API Key，或选择清除现有密钥")
        if key:
            keys[profile.id] = key
    return keys


def _update(data: SaveInput, current: Catalog, keys: dict[UUID, str]) -> Catalog:
    previous = {profile.id: profile for profile in current.models}
    profiles: dict[UUID, StoredProfile] = {}
    names: set[str] = set()
    for profile in data.models:
        name = profile.name.casefold()
        if name in names or profile.id in profiles:
            raise WorkError(422, "模型名称或标识重复")
        names.add(name)
        try:
            base_url = normalize_base_url(profile.base_url)
        except ValueError as exc:
            raise WorkError(422, "模型地址无效。请填写 HTTPS 或本机回环地址。") from exc
        prior = previous.get(profile.id)
        encrypted_key = prior.encrypted_key if prior else ""
        if profile.id in keys:
            encrypted_key = _cipher().encrypt(keys[profile.id].encode()).decode()
        elif profile.clear_key:
            encrypted_key = ""
        elif prior and encrypted_key and prior.base_url != base_url:
            raise WorkError(422, "模型地址已变更，请重新填写 API Key 或清除已有密钥")
        values = profile.model_dump(exclude={"base_url", "api_key", "clear_key"})
        profiles[profile.id] = StoredProfile(
            **values, base_url=base_url, encrypted_key=encrypted_key
        )
    for scene, model_id in data.assignments.items():
        if scene not in SCENES or model_id not in profiles:
            raise WorkError(422, "场景分配无效，请先调整使用已移除模型的场景")
        if scene == "image_analysis" and not profiles[model_id].vision:
            raise WorkError(422, "图片分析需要支持图片输入的模型")
    return Catalog(models=list(profiles.values()), assignments=data.assignments)


def save(engine: Engine, account: str, data: SaveInput) -> dict[str, object]:
    """Serialize per-account writes and read back a secret-free receipt."""
    keys = _keys(data)
    if keys:
        _cipher()
    secret_tags = {
        str(model_id): hmac.digest(
            os.environ["TODO_STORAGE_ENCRYPTION_KEY"].encode(), key.encode(), "sha256"
        ).hex()
        for model_id, key in keys.items()
    }
    safe = data.model_dump(mode="json", exclude={"operation_id"})
    fingerprint = hashlib.sha256(
        json.dumps([safe, secret_tags], sort_keys=True).encode()
    ).hexdigest()
    with engine.begin() as conn:
        ensure_row = sqlite_insert if engine.dialect.name == "sqlite" else pg_insert
        conn.execute(
            ensure_row(catalogs)
            .values(account=account, configuration="{}", revision=0)
            .on_conflict_do_nothing(index_elements=[catalogs.c.account])
        )
        row = _row(conn, account, lock=True)
        assert row is not None
        prior = conn.execute(
            select(receipts.c.fingerprint).where(
                receipts.c.account == account, receipts.c.id == str(data.operation_id)
            )
        ).scalar_one_or_none()
        if prior is not None:
            if prior != fingerprint:
                raise WorkError(409, "操作标识已用于其他配置")
        else:
            if row["revision"] != data.expected_revision:
                raise WorkError(409, "配置已更新，请重新加载后保存")
            catalog = _update(data, _catalog(row), keys)
            revision = data.expected_revision + 1
            conn.execute(
                update(catalogs)
                .where(catalogs.c.account == account)
                .values(configuration=catalog.model_dump_json(), revision=revision)
            )
            conn.execute(
                insert(receipts).values(
                    account=account,
                    id=str(data.operation_id),
                    fingerprint=fingerprint,
                    result=json.dumps(_view(catalog, revision)),
                )
            )
    with engine.connect() as conn:
        return receipt(conn, account, data.operation_id)


def _target(profile: StoredProfile) -> ModelTarget:
    key = ""
    if profile.encrypted_key:
        try:
            key = _cipher().decrypt(profile.encrypted_key.encode()).decode()
        except InvalidToken as exc:
            raise WorkError(503, "模型密钥无法解密，请在设置中替换") from exc
    return ModelTarget(profile.base_url, profile.model, key)


def override(conn: Connection, account: str, scene: str) -> tuple[ModelTarget] | tuple[()]:
    """Return the assigned model argument, or omit it to invoke the existing default."""
    catalog = _catalog(_row(conn, account))
    model_id = catalog.assignments.get(scene)
    if model_id is None:
        return ()
    profile = catalog.find(model_id)
    if profile is None:
        raise WorkError(503, "场景模型已失效，请重新分配")
    return (_target(profile),)


def check(engine: Engine, account: str, model_id: UUID) -> dict[str, str]:
    """Check a saved model using only its provider's model catalog."""
    with engine.connect() as conn:
        profile = _catalog(_row(conn, account)).find(model_id)
        if not profile:
            raise WorkError(404, "模型不存在，请先保存配置")
        target = _target(profile)
    try:
        visible = vision.model_listed(target.model, target.key, target.base_url)
    except AIError as exc:
        raise WorkError(502, str(exc)) from exc
    if not visible:
        raise WorkError(422, "模型目录中未找到此 ID，请核对地址、模型 ID 和授权范围")
    return {"message": "目录中已找到模型。实际调用使用各场景的输入和能力要求。"}
