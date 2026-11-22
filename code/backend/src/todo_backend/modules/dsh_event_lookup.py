"""Locate bounded event candidates without writing suggestions or business records."""

import json
import math
import os
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Select, bindparam, or_, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import FromClause

from todo_backend.integrations.ai.embeddings import EmbeddingError, configuration, embed
from todo_backend.modules.dsh_capture import validate_account, validate_lookup_text
from todo_backend.modules.memory.retrieval import valid_cards
from todo_backend.modules.memory.schemas import CardOutput
from todo_backend.modules.memory.service import enabled as memory_enabled
from todo_backend.modules.work.repository import deletions, items
from todo_backend.modules.work.service import WorkError

MODULE_LIMIT = 3
EVENT_LIMIT = 10
RESPONSE_BYTES = 16 * 1024
ScopeMethod = Literal["explicit", "module_memory", "vector_memory"]
LookupStatus = Literal["candidates", "no_scope", "scope_ambiguous", "no_events", "unavailable"]
_ACTIVE = ("notStarted", "working")
_GOAL = items.alias("lookup_goal")
_MODULE = items.alias("lookup_module")
_MATTER = items.alias("lookup_matter")
_EVENT = items.alias("lookup_event")


class EventCandidate(BaseModel):
    """A current event summary; IDs and versions are for callers, not user input."""

    event_id: str
    version: int
    title: str
    path: tuple[str, str, str]
    status: str


class EventLookup(BaseModel):
    """Distinguish an inconclusive search from a missing or unavailable scope."""

    status: LookupStatus
    message: str
    scope_method: ScopeMethod | None = None
    events: list[EventCandidate] = Field(default_factory=list)
    truncated: bool = False


@dataclass(frozen=True)
class _Scope:
    method: ScopeMethod
    module_ids: tuple[str, ...]
    matter_ids: tuple[str, ...] = ()


def enabled() -> bool:
    """Opt in to exposing current event summaries to the MCP read connection."""
    return os.environ.get("TODO_DSH_EVENT_LOOKUP") == "1"


def _visible(account: str, table: FromClause, kind: str) -> tuple[ColumnElement[bool], ...]:
    return (
        table.c.account == account,
        table.c.type == kind,
        table.c.status.in_(_ACTIVE),
        table.c.id.not_in(select(deletions.c.item_id)),
    )


def _modules(account: str) -> Select[tuple[str]]:
    return (
        select(_MODULE.c.id)
        .select_from(_MODULE.join(_GOAL, _GOAL.c.id == _MODULE.c.parent))
        .where(*_visible(account, _MODULE, "module"), *_visible(account, _GOAL, "goal"))
    )


def _explicit(conn: Connection, account: str, hint: str) -> _Scope | EventLookup:
    module_path = _GOAL.c.name + " / " + _MODULE.c.name
    matters = (
        _modules(account)
        .add_columns(_MATTER.c.id)
        .join(_MATTER, _MATTER.c.parent == _MODULE.c.id)
        .where(
            *_visible(account, _MATTER, "thing"),
            or_(_MATTER.c.name == hint, module_path + " / " + _MATTER.c.name == hint),
        )
        .order_by(_MODULE.c.id, _MATTER.c.id)
        .limit(MODULE_LIMIT + 1)
    )
    # Do not choose a type silently when a title names both a matter and a module.
    module_ids = tuple(
        conn.scalars(
            _modules(account)
            .where(or_(_MODULE.c.name == hint, _GOAL.c.name == hint, module_path == hint))
            .order_by(_MODULE.c.id)
            .limit(MODULE_LIMIT + 1)
        )
    )
    rows = conn.execute(matters).all()
    if len(rows) > MODULE_LIMIT or len(module_ids) > MODULE_LIMIT or (rows and module_ids):
        return _ambiguous()
    if rows:
        return _Scope(
            "explicit", tuple(dict.fromkeys(row[0] for row in rows)), tuple(row[1] for row in rows)
        )
    if module_ids:
        return _Scope("explicit", module_ids)
    return _no_scope()


def _ambiguous() -> EventLookup:
    return EventLookup(
        status="scope_ambiguous", message="相关范围不唯一，请补充更具体的项目、模块或事情。"
    )


def _no_scope() -> EventLookup:
    return EventLookup(
        status="no_scope", message="没有可靠定位到模块；未查询事件。请补充项目、事情或事件线索。"
    )


def _unavailable(message: str) -> EventLookup:
    return EventLookup(status="unavailable", message=message)


def _valid_memory(conn: Connection, account: str) -> list[CardOutput]:
    active = set(conn.scalars(_modules(account)))
    return [card for card in valid_cards(conn, account, "") if card.module_id in active]


def _literal(content: str, card: CardOutput) -> bool:
    terms = [card.path.rsplit(" / ", 1)[-1], *card.aliases]
    return any(term.casefold() in content.casefold() for term in terms if len(term.strip()) >= 2)


_VECTOR_WHERE = (
    " FROM memory_vectors v JOIN memory_cards c "
    "ON c.account=v.account AND c.module_id=v.module_id AND c.version=v.revision "
    "WHERE v.account=:account AND v.profile=:profile AND c.enabled=true AND v.module_id IN :ids "
)


def _has_indexes(conn: Connection, account: str, profile: str, ids: tuple[str, ...]) -> bool:
    statement = text("SELECT 1" + _VECTOR_WHERE + "LIMIT 1").bindparams(
        bindparam("ids", expanding=True)
    )
    return (
        conn.execute(statement, {"account": account, "profile": profile, "ids": ids}).first()
        is not None
    )


def _nearest(
    conn: Connection,
    account: str,
    profile: str,
    ids: tuple[str, ...],
    vector: list[float],
    max_distance: float,
) -> tuple[str, ...]:
    # Keep profile/scope filtering inside a MATERIALIZED CTE before comparing dimensions.
    statement = text(
        "WITH eligible AS MATERIALIZED (SELECT v.module_id, v.embedding" + _VECTOR_WHERE + ") "
        "SELECT module_id FROM (SELECT module_id, embedding OPERATOR(public.<=>) "
        "CAST(:vector AS public.vector) AS distance FROM eligible) ranked "
        "WHERE distance <= :max_distance ORDER BY distance, module_id LIMIT :limit"
    ).bindparams(bindparam("ids", expanding=True))
    return tuple(
        conn.execute(
            statement,
            {
                "account": account,
                "profile": profile,
                "ids": ids,
                "vector": json.dumps(vector),
                "max_distance": max_distance,
                "limit": MODULE_LIMIT + 1,
            },
        ).scalars()
    )


def _calibrated_distance(profile: str) -> float:
    configured_profile, _, raw = os.environ.get("TODO_DSH_EVENT_VECTOR_CALIBRATION", "").partition(
        ":"
    )
    try:
        distance = float(raw)
    except ValueError as exc:
        raise EmbeddingError("未配置语义匹配阈值") from exc
    if configured_profile != profile or not math.isfinite(distance) or not 0 < distance < 2:
        raise EmbeddingError("当前向量模型未配置有效的匹配阈值")
    return distance


def _candidates(conn: Connection, account: str, scope: _Scope) -> EventLookup:
    statement = (
        select(
            _EVENT.c.id,
            _EVENT.c.version,
            _EVENT.c.name,
            _EVENT.c.status,
            _GOAL.c.name,
            _MODULE.c.name,
            _MATTER.c.name,
        )
        .select_from(
            _EVENT.join(_MATTER, _EVENT.c.parent == _MATTER.c.id)
            .join(_MODULE, _MATTER.c.parent == _MODULE.c.id)
            .join(_GOAL, _MODULE.c.parent == _GOAL.c.id)
        )
        .where(
            *_visible(account, _EVENT, "event"),
            *_visible(account, _MATTER, "thing"),
            *_visible(account, _MODULE, "module"),
            *_visible(account, _GOAL, "goal"),
            _MODULE.c.id.in_(scope.module_ids),
        )
        .order_by(_GOAL.c.name, _MODULE.c.name, _MATTER.c.name, _EVENT.c.name, _EVENT.c.id)
        .limit(EVENT_LIMIT + 1)
    )
    if scope.matter_ids:
        statement = statement.where(_MATTER.c.id.in_(scope.matter_ids))
    rows = conn.execute(statement).all()
    if not rows:
        return EventLookup(
            status="no_events",
            scope_method=scope.method,
            message="本轮范围内没有未结束事件。请补充线索，不自动扩大范围。",
        )
    result = EventLookup(
        status="candidates",
        scope_method=scope.method,
        message="以下只供核对，不代表已定位或更新。没有可靠对应就请用户补线索，不扩大范围。",
        events=[
            EventCandidate(
                event_id=row[0],
                version=row[1],
                title=row[2],
                status=row[3],
                path=(row[4], row[5], row[6]),
            )
            for row in rows[:EVENT_LIMIT]
        ],
        truncated=len(rows) > EVENT_LIMIT,
    )
    while len(result.model_dump_json().encode("utf-8")) > RESPONSE_BYTES:
        result.events.pop()
        result.truncated = True
        if not result.events:
            return EventLookup(
                status="unavailable",
                scope_method=scope.method,
                truncated=True,
                message="候选超出本轮读取预算，请补充更具体的线索。",
            )
    return result


def _locate(engine: Engine, account: str, content: str, hint: str) -> EventLookup:
    with engine.begin() as conn:
        if hint:
            explicit = _explicit(conn, account, hint)
            return (
                explicit
                if isinstance(explicit, EventLookup)
                else _candidates(conn, account, explicit)
            )
        if not memory_enabled():
            return _unavailable("模块记忆未启用；请补充明确的项目、模块或事情。")
        cards = _valid_memory(conn, account)
        literal = tuple(card.module_id for card in cards if _literal(content, card))
        if len(literal) > MODULE_LIMIT:
            return _ambiguous()
        if literal:
            return _candidates(conn, account, _Scope("module_memory", literal))
        if not cards:
            return _unavailable("没有有效模块记忆；请补充明确的项目、模块或事情。")
        if os.environ.get("TODO_DSH_EVENT_EMBEDDING_CONSENT") != "1":
            return _unavailable("当前未授权会话语义查询；请补充明确的项目、模块或事情。")
        if engine.dialect.name != "postgresql":
            return _unavailable("语义查询需要 PostgreSQL 和向量索引；请补充明确范围。")
        try:
            config = configuration()
            distance = _calibrated_distance(config.profile)
        except EmbeddingError:
            return _unavailable("当前向量服务未配置、未授权或未校准；请补充明确范围。")
        if not _has_indexes(conn, account, config.profile, tuple(c.module_id for c in cards)):
            return _unavailable("没有可用的当前模块向量索引；请补充明确范围。")

    validate_lookup_text(content, account, (config.key,))
    try:
        vector = embed(content, config)
    except EmbeddingError:
        return _unavailable("语义查询暂不可用，未查询事件；可补充明确范围。")
    with engine.begin() as conn:
        if not memory_enabled() or os.environ.get("TODO_DSH_EVENT_EMBEDDING_CONSENT") != "1":
            return _unavailable("会话语义查询已停用，未查询事件。")
        try:
            if (
                configuration().profile != config.profile
                or _calibrated_distance(config.profile) != distance
            ):
                return _unavailable("向量配置已变化，未查询事件。")
        except EmbeddingError:
            return _unavailable("向量配置已变化，未查询事件。")
        if cards != _valid_memory(conn, account):
            return _unavailable("模块记忆已变化，未查询事件；请重新补充线索。")
        ids = tuple(card.module_id for card in cards)
        if not _has_indexes(conn, account, config.profile, ids):
            return _unavailable("模块向量索引已不可用，未查询事件。")
        matches = _nearest(conn, account, config.profile, ids, vector, distance)
        if len(matches) > MODULE_LIMIT:
            return _ambiguous()
        return (
            _candidates(conn, account, _Scope("vector_memory", matches)) if matches else _no_scope()
        )


def locate(engine: Engine, account: str, content: str, scope_hint: str = "") -> EventLookup:
    """Use only current authorized module evidence and bounded formal event summaries."""
    if not enabled():
        return _unavailable("会话事件定位未启用。")
    validate_account(account)
    content, scope_hint = content.strip(), scope_hint.strip()
    if not 1 <= len(content) <= 1000 or len(scope_hint) > 370:
        raise WorkError(422, "描述须为 1–1000 字，范围线索最多 370 字")
    validate_lookup_text(content, account)
    if scope_hint:
        validate_lookup_text(scope_hint, account)
    try:
        return _locate(engine, account, content, scope_hint)
    except (SQLAlchemyError, ValidationError, ValueError):
        return _unavailable("暂时无法核实事件或模块记忆，未更新任何状态。")
