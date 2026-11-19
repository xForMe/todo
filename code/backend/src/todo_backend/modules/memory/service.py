"""Account-scoped card confirmation, idempotency and live business validation."""

import hashlib
import json
import os

from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from todo_backend.modules.memory.provenance import origins_valid
from todo_backend.modules.memory.repository import cards, jobs, receipts
from todo_backend.modules.memory.schemas import CardInput, CardOutput
from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.service import WorkError

MAX_CARDS = 500
MAX_OPERATIONS = 10000


def enabled() -> bool:
    """Keep new memory reads and writes off until explicitly configured."""
    return os.environ.get("TODO_MEMORY_ENABLED", "0") == "1"


def require_enabled() -> None:
    """Reject writes when the feature is disabled."""
    if not enabled():
        raise WorkError(409, "模块记忆尚未启用")


def digest(value: str) -> str:
    """Fingerprint content without storing an extra copy of its plaintext."""
    return hashlib.sha256(value.encode()).hexdigest()


def lock_account(conn: Connection, account: str) -> None:
    """Serialize account budgets without silently retrying conflicts."""
    if conn.dialect.name == "sqlite":
        conn.exec_driver_sql("BEGIN IMMEDIATE")
    else:
        key = int.from_bytes(hashlib.sha256(account.encode()).digest()[:8], signed=True)
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


def module_scope(conn: Connection, account: str, module_id: str) -> tuple[str, str]:
    """Validate both module and goal, deriving freshness from current facts."""
    module = read_item(conn, account, module_id)
    if module is None or module.type != "module":
        raise WorkError(404, "模块不存在或不可访问")
    goal = read_item(conn, account, module.parent or "")
    if goal is None or goal.type != "goal":
        raise WorkError(404, "目标不存在或不可访问")
    stamp = digest(goal.model_dump_json() + module.model_dump_json())
    return f"{goal.name} / {module.name}", stamp


def read_card(conn: Connection, account: str, module_id: str) -> CardOutput:
    """Read current editable state without trusting stored scope or path."""
    path, stamp = module_scope(conn, account, module_id)
    row = (
        conn.execute(
            select(cards).where(cards.c.account == account, cards.c.module_id == module_id)
        )
        .mappings()
        .first()
    )
    if row is None:
        return CardOutput(
            module_id=module_id,
            path=path,
            scope_version=stamp,
            version=0,
            description="",
            aliases=[],
            enabled=True,
            usable=False,
            status="未配置",
        )
    source_valid = origins_valid(conn, account, module_id)
    usable = bool(row["enabled"]) and row["scope_version"] == stamp and source_valid
    return CardOutput(
        module_id=module_id,
        path=path,
        scope_version=stamp,
        version=row["version"],
        description=row["description"] if source_valid else "",
        aliases=json.loads(row["aliases"]) if source_valid else [],
        enabled=row["enabled"],
        usable=usable,
        status=(
            "已确认"
            if usable
            else "已停用"
            if not row["enabled"]
            else "来源已失效，请重新核对"
            if not source_valid
            else "模块已变化，请重新确认"
        ),
    )


def operation_result(conn: Connection, account: str, op: str) -> CardOutput:
    """Return the original committed result, never another account's receipt."""
    value = conn.execute(
        select(receipts.c.result).where(receipts.c.account == account, receipts.c.id == op)
    ).scalar_one_or_none()
    if value is None:
        raise WorkError(404, "尚未查到成功回执，请保留操作标识")
    result = CardOutput.model_validate_json(value)
    module_scope(conn, account, result.module_id)
    if not origins_valid(conn, account, result.module_id):
        result = result.model_copy(
            update={
                "description": "",
                "aliases": [],
                "usable": False,
                "status": "来源已失效，请重新核对",
            }
        )
    return result


def save_card(engine: Engine, account: str, module_id: str, data: CardInput) -> CardOutput:
    """Confirm one bounded card; invalidate old vectors in the same transaction."""
    require_enabled()
    fingerprint = digest(module_id + data.model_dump_json())
    op = str(data.operation_id)
    try:
        with engine.begin() as conn:
            lock_account(conn, account)
            current = read_card(conn, account, module_id)
            prior = (
                conn.execute(
                    select(receipts).where(receipts.c.account == account, receipts.c.id == op)
                )
                .mappings()
                .first()
            )
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise WorkError(409, "操作标识已用于其他内容")
            else:
                if (
                    current.version != data.expected_version
                    or current.scope_version != data.scope_version
                ):
                    raise WorkError(409, "模块或记忆已变化，请刷新后核对")
                if data.enabled and not (data.description or data.aliases):
                    raise WorkError(422, "请填写模块职责或简称")
                if data.candidate_id:
                    from todo_backend.modules.memory.candidates import prepare_confirmation

                    prepare_confirmation(conn, account, module_id, data)
                count = conn.execute(
                    select(func.count()).select_from(cards).where(cards.c.account == account)
                ).scalar_one()
                op_count = conn.execute(
                    select(func.count()).select_from(receipts).where(receipts.c.account == account)
                ).scalar_one()
                # Reserve one revocation receipt per card: capacity must not prevent disabling.
                revoking = current.version > 0 and current.enabled and not data.enabled
                receipt_limit = MAX_OPERATIONS + MAX_CARDS if revoking else MAX_OPERATIONS
                if (current.version == 0 and count >= MAX_CARDS) or op_count >= receipt_limit:
                    raise WorkError(409, "达到记忆容量上限，未保存；请联系管理员核对留存策略")
                values = dict(
                    version=current.version + 1,
                    scope_version=data.scope_version,
                    description=data.description,
                    aliases=json.dumps(data.aliases, ensure_ascii=False),
                    enabled=data.enabled,
                )
                if current.version:
                    conn.execute(
                        update(cards)
                        .where(cards.c.account == account, cards.c.module_id == module_id)
                        .values(**values)
                    )
                else:
                    conn.execute(
                        insert(cards).values(account=account, module_id=module_id, **values)
                    )
                conn.execute(
                    text("DELETE FROM memory_vectors WHERE account=:a AND module_id=:m"),
                    {"a": account, "m": module_id},
                )
                conn.execute(
                    delete(jobs).where(jobs.c.account == account, jobs.c.module_id == module_id)
                )
                result = read_card(conn, account, module_id)
                conn.execute(
                    insert(receipts).values(
                        account=account,
                        id=op,
                        fingerprint=fingerprint,
                        result=result.model_dump_json(),
                    )
                )
        with engine.connect() as check:
            return operation_result(check, account, op)
    except SQLAlchemyError as exc:
        raise WorkError(503, "保存结果待核对，请查询操作回执，不要重复提交") from exc
