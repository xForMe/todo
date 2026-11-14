"""Durable private reminder state and explicit authorization."""

import re
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from pydantic import BaseModel, Field
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Integer,
    String,
    Table,
    Text,
    insert,
    select,
    update,
)
from sqlalchemy.engine import Engine

from todo_backend.modules.work.repository import metadata, read_item
from todo_backend.modules.work.service import WorkError

rules = Table(
    "follow_rules",
    metadata,
    Column("event_id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("recipient", String(80), nullable=False),
    Column("content", Text, nullable=False),
    Column("at", String(5), nullable=False),
    Column("cap", Integer, nullable=False),
    Column("count", Integer, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("event_version", Integer, nullable=False),
    Column("version", Integer, nullable=False),
    Column("next_run", BigInteger, nullable=False),
    Column("status", Text, nullable=False),
)
attempts = Table(
    "follow_attempts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("event_id", String(36), nullable=False),
    Column("account", String(120), nullable=False),
    Column("created", BigInteger, nullable=False),
    Column("content", Text, nullable=False),
    Column("state", String(16), nullable=False),
    Column("message_id", String(80), nullable=False),
)


class RuleInput(BaseModel):
    """The exact user-authorized sending scope."""

    recipient: str = Field(max_length=80)
    content: str = Field(min_length=1, max_length=2000)
    at: str = "09:00"
    cap: int = Field(default=3, ge=1, le=10)
    enabled: bool = False
    verified: bool = False
    expected_version: int = 0
    event_version: int


def next_time(end: str, at: str) -> int:
    """Schedule after the end date, skipping missed daily slots in UTC+8."""
    zone = timezone(timedelta(hours=8))
    now = datetime.now(zone)
    due = datetime.fromisoformat(end + "T" + at).replace(tzinfo=zone) + timedelta(days=1)
    today = now.replace(hour=due.hour, minute=due.minute, second=0, microsecond=0)
    return int(max(due, today if today > now else today + timedelta(days=1)).timestamp())


def list_rules(engine: Engine, account: str) -> list[dict[str, object]]:
    """Read back authorized rules and their own sending records."""
    with engine.connect() as conn:
        rows = conn.execute(select(rules).where(rules.c.account == account)).mappings()
        result = []
        for row in rows:
            record = {str(k): v for k, v in row.items() if k != "account"}
            logs = conn.execute(
                select(attempts).where(
                    attempts.c.account == account, attempts.c.event_id == row["event_id"]
                )
            ).mappings()
            record["logs"] = [{str(k): v for k, v in log.items() if k != "account"} for log in logs]
            result.append(record)
        return result


def save_rule(engine: Engine, account: str, event_id: str, data: RuleInput) -> dict[str, object]:
    """Verify event scope and state before persisting explicit approval."""
    if not re.fullmatch(r"ou_[A-Za-z0-9]+", data.recipient):
        raise WorkError(422, "请填写已核实的责任人 open_id")
    if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", data.at):
        raise WorkError(422, "发送时间须为 HH:MM")
    with engine.begin() as conn:
        event = read_item(conn, account, event_id)
        if event is None or event.type != "event":
            raise WorkError(404, "事件不可访问")
        if event.version != data.event_version:
            raise WorkError(409, "事件已变化，请重新核实")
        if data.enabled and (
            not data.verified
            or not event.owner
            or not event.planEnd
            or event.status in {"completed", "cancelled"}
        ):
            raise WorkError(422, "请核实责任人和结束日期，只能为未完成事件开启催办")
        row = conn.execute(select(rules).where(rules.c.event_id == event_id)).mappings().first()
        version = row["version"] if row else 0
        if version != data.expected_version:
            raise WorkError(409, "规则已变化，请刷新核对")
        unknown = conn.execute(
            select(attempts.c.id).where(
                attempts.c.event_id == event_id, attempts.c.state.in_(["pending", "unknown"])
            )
        ).first()
        if data.enabled and unknown:
            raise WorkError(409, "存在结果未知的发送，请先核对，禁止重新开启重发")
        count = row["count"] if row else 0
        if data.enabled and count >= data.cap:
            raise WorkError(422, "已达到累计次数上限")
        values = data.model_dump(exclude={"verified", "expected_version"})
        values.update(
            account=account,
            version=version + 1,
            count=count,
            next_run=next_time(event.planEnd, data.at) if data.enabled else 0,
            status="已开启" if data.enabled else "已暂停",
        )
        if row:
            changed = conn.execute(
                update(rules)
                .where(rules.c.event_id == event_id, rules.c.version == version)
                .values(**values)
            )
            if changed.rowcount != 1:
                raise WorkError(409, "规则已变化")
        else:
            conn.execute(insert(rules).values(event_id=event_id, **values))
    return next(r for r in list_rules(engine, account) if r["event_id"] == event_id)


def send_due(engine: Engine) -> None:
    """Persist each attempt before dispatch; never retry an uncertain send."""
    from todo_backend.integrations.feishu_cli.sender import SendFailure, send_message

    now = int(time.time())
    with engine.begin() as conn:
        row = (
            conn.execute(
                select(rules).where(rules.c.enabled.is_(True), rules.c.next_run <= now).limit(1)
            )
            .mappings()
            .first()
        )
        if row is None:
            return
        event = read_item(conn, row["account"], row["event_id"])
        if (
            event is None
            or event.version != row["event_version"]
            or event.status in {"completed", "cancelled"}
        ):
            conn.execute(
                update(rules)
                .where(rules.c.event_id == row["event_id"])
                .values(enabled=False, status="事件变化，已暂停", version=row["version"] + 1)
            )
            return
        changed = conn.execute(
            update(rules)
            .where(
                rules.c.event_id == row["event_id"],
                rules.c.version == row["version"],
                rules.c.enabled.is_(True),
            )
            .values(enabled=False, status="本轮发送处理中", version=row["version"] + 1)
        )
        if changed.rowcount != 1:
            return
        attempt_id = str(uuid4())
        conn.execute(
            insert(attempts).values(
                id=attempt_id,
                event_id=row["event_id"],
                account=row["account"],
                content=row["content"],
                created=now,
                state="pending",
                message_id="",
            )
        )
    try:
        message_id = send_message(row["recipient"], row["content"], attempt_id)
        state = "confirmed"
    except SendFailure:
        message_id = ""
        state = "unknown"
    with engine.begin() as conn:
        conn.execute(
            update(attempts)
            .where(attempts.c.id == attempt_id)
            .values(state=state, message_id=message_id)
        )
        count = row["count"] + (1 if state == "confirmed" else 0)
        if state == "confirmed":
            conn.execute(
                update(rules)
                .where(rules.c.event_id == row["event_id"])
                .values(count=rules.c.count + 1)
            )
        conn.execute(
            update(rules)
            .where(rules.c.event_id == row["event_id"], rules.c.version == row["version"] + 1)
            .values(
                enabled=state == "confirmed" and count < row["cap"],
                next_run=now + 86400,
                status="已读回确认" if state == "confirmed" else "结果未知，已暂停",
            )
        )
