"""Read selected private images and create proposed events only on confirmation."""

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import insert, select, update
from sqlalchemy.engine import Connection, Engine, RowMapping

from todo_backend.integrations.ai import vision
from todo_backend.integrations.ai.client import AIError
from todo_backend.modules import model_catalog
from todo_backend.modules.images import configuration, model_settings, service
from todo_backend.modules.images.repository import action_runs, action_sources, images
from todo_backend.modules.work.event_repository import branches
from todo_backend.modules.work.event_structure import require_open, state
from todo_backend.modules.work.plan_history import initialize
from todo_backend.modules.work.repository import deletions, items, read_item
from todo_backend.modules.work.schemas import ItemInput, ItemOutput
from todo_backend.modules.work.service import WorkError


class AnalyzeInput(BaseModel):
    """Only selected, already stored image identifiers cross the HTTP boundary."""

    model_config = ConfigDict(extra="forbid")
    image_ids: list[UUID] = Field(min_length=1, max_length=4)


class Candidate(BaseModel):
    """An editable candidate requires a name and keeps other fields optional."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    owner: str = Field(default="", max_length=80)
    planEnd: str = Field(default="", max_length=10)


class Proposed(Candidate):
    """The model must cite one of the selected images and a visible basis."""

    image_id: UUID
    evidence: str = Field(min_length=1, max_length=500)


class Proposal(BaseModel):
    """Bound the model response and distinguish successful empty output."""

    model_config = ConfigDict(extra="forbid")
    summary: str = Field(max_length=1200)
    candidates: list[Proposed] = Field(max_length=8)


class Edited(Candidate):
    """An edited candidate points to a fixed slot in the persisted batch."""

    index: int = Field(ge=0, le=7)


class ConfirmInput(BaseModel):
    """One user confirmation can create several selected events atomically."""

    model_config = ConfigDict(extra="forbid")
    candidates: list[Edited] = Field(min_length=1, max_length=8)


@dataclass(frozen=True)
class Context:
    """Version-bound image and work scope used both before analysis and confirmation."""

    item: ItemOutput
    matter_id: str
    pictures: list[dict[str, object]]
    work: str
    snapshot: str
    names: set[str]


def context(
    conn: Connection, account: str, item_id: str, ids: list[str], *, lock: bool = False
) -> Context:
    """Check the visible ancestry and detect changes to existing work or images."""
    item = service.image_target(conn, account, item_id)
    matter_id = item.id if item.type == "thing" else item.parent or ""
    matter = read_item(conn, account, matter_id)
    module = read_item(conn, account, matter.parent or "") if matter else None
    goal = read_item(conn, account, module.parent or "") if module else None
    if not matter or matter.type != "thing" or not module or not goal:
        raise WorkError(409, "当前事情的归属已变化")
    if matter.status in {"completed", "cancelled"}:
        raise WorkError(409, "请先手动重开当前事情")
    if item.type == "event":
        require_open(conn, account, item_id)
    pictures = service.ready_images(conn, account, item_id, ids, lock=lock)
    if sum(int(str(row["size"])) for row in pictures) > 12 * 1024 * 1024:
        raise WorkError(422, "单次分析的图片总大小不能超过12MiB")
    events = [
        dict(row)
        for row in conn.execute(
            select(items.c.id, items.c.name, items.c.version, items.c.status)
            .where(
                items.c.account == account,
                items.c.parent == matter_id,
                items.c.type == "event",
                items.c.id.not_in(select(deletions.c.item_id)),
            )
            .order_by(items.c.id)
        ).mappings()
    ]
    chain = [goal, module, matter] + ([item] if item.type == "event" else [])
    work = json.dumps(
        {
            "path": [entry.name for entry in chain],
            "description": item.description[:2000],
            "planEnd": item.planEnd,
            "existing": events[:80],
        },
        ensure_ascii=False,
    )
    snapshot = configuration.fingerprint(
        [
            [entry.model_dump(mode="json") for entry in chain],
            events,
            state(conn, account, item_id)["snapshot"] if item.type == "event" else "",
            [[row[k] for k in ("id", "revision", "sha256")] for row in pictures],
        ]
    )
    return Context(item, matter_id, pictures, work, snapshot, {str(row["name"]) for row in events})


def analyze(engine: Engine, account: str, item_id: str, data: AnalyzeInput) -> dict[str, object]:
    """Analyze once, then check the material is still current before saving the batch."""
    ids = [str(value) for value in data.image_ids]
    with engine.connect() as conn:
        current = context(conn, account, item_id, ids)
        model_override = model_catalog.override(conn, account, "image_analysis")
        if model_override:
            target = model_override[0]
            model, key = target.model, target.key
        else:
            model, key = model_settings.resolve(conn, account)
        sources = [
            configuration.storage(conn, account, str(row["profile_id"])) for row in current.pictures
        ]
    pictures: list[vision.Picture] = []
    for row, source in zip(current.pictures, sources, strict=True):
        size = int(str(row["size"]))
        raw = source.read(str(row["object_key"]), size)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise WorkError(409, "云端图片内容已变化，请核对原图片")
        pictures.append(vision.Picture(str(row["id"]), str(row["mime"]), raw))
    try:
        proposal = Proposal.model_validate(
            vision.analyze(model, current.work, pictures, key, *model_override)
        )
    except (AIError, ValidationError) as exc:
        raise WorkError(502, "图片分析失败，请检查视觉模型支持、凭据或额度后重试") from exc
    for candidate in proposal.candidates:
        if str(candidate.image_id) not in ids:
            raise WorkError(502, "模型返回了无法核对的图片依据，请重新分析")
        candidate.owner = candidate.owner if candidate.owner in candidate.evidence else ""
        try:
            end = candidate.planEnd
            if end and (
                date.fromisoformat(end).isoformat() != end or end not in candidate.evidence
            ):
                candidate.planEnd = ""
        except ValueError:
            candidate.planEnd = ""
    run_id = str(uuid4())
    payload = {"image_ids": ids, **proposal.model_dump(mode="json")}
    with engine.begin() as conn:
        if context(conn, account, item_id, ids).snapshot != current.snapshot:
            raise WorkError(409, "分析期间图片或工作内容已变化，请重新分析")
        conn.execute(
            insert(action_runs).values(
                id=run_id,
                account=account,
                item_id=item_id,
                snapshot=current.snapshot,
                model=model,
                proposal=json.dumps(payload),
            )
        )
    with engine.connect() as conn:
        stored = json.loads(run(conn, account, item_id, run_id)["proposal"])
    return {
        "id": run_id,
        **stored,
        "duplicates": sorted(current.names & {candidate.name for candidate in proposal.candidates}),
    }


def run(
    conn: Connection, account: str, item_id: str, run_id: str, *, lock: bool = False
) -> RowMapping:
    """Read only batches owned by the authenticated account and exact work item."""
    query = select(action_runs).where(
        action_runs.c.id == run_id,
        action_runs.c.account == account,
        action_runs.c.item_id == item_id,
    )
    row = conn.execute(query.with_for_update() if lock else query).mappings().first()
    if row is None:
        raise WorkError(404, "未找到图片分析批次")
    return row


def result(engine: Engine, account: str, item_id: str, run_id: str) -> dict[str, object]:
    """Read the committed result without resubmitting an uncertain confirmation."""
    with engine.connect() as conn:
        service.image_target(conn, account, item_id)
        raw = run(conn, account, item_id, run_id)["result"]
    if not raw:
        raise WorkError(404, "尚未找到确认结果")
    value: dict[str, object] = json.loads(raw)
    return value


def confirm(
    engine: Engine, account: str, item_id: str, run_id: str, data: ConfirmInput
) -> dict[str, object]:
    """Commit selected events, parent edges and source evidence in one transaction."""
    edited = data.candidates
    if len({value.index for value in edited}) != len(edited):
        raise WorkError(422, "候选不能重复选择")
    fingerprint = configuration.fingerprint(data.model_dump(mode="json"))
    with engine.begin() as conn:
        if engine.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        row = run(conn, account, item_id, run_id, lock=True)
        if row["result"]:
            if row["confirmation"] != fingerprint:
                raise WorkError(409, "此批次已确认，请核对原结果")
        else:
            stored = json.loads(row["proposal"])
            conn.execute(
                select(items.c.id)
                .where(items.c.id == item_id, items.c.account == account)
                .with_for_update()
            )
            current = context(conn, account, item_id, stored["image_ids"], lock=True)
            if current.snapshot != row["snapshot"]:
                raise WorkError(409, "图片或工作内容已变化，请重新分析")
            created = []
            for candidate in edited:
                if candidate.index >= len(stored["candidates"]):
                    raise WorkError(422, "候选不属于当前分析批次")
                if candidate.name in current.names:
                    raise WorkError(409, "事件名重复，请核对后修改名称")
                current.names.add(candidate.name)
                try:
                    item = ItemInput(
                        type="event",
                        parent=current.matter_id,
                        **candidate.model_dump(exclude={"index"}),
                    )
                except ValidationError as exc:
                    raise WorkError(422, "请检查事件名称与日期格式") from exc
                event_id = str(uuid4())
                conn.execute(
                    insert(items).values(
                        id=event_id, account=account, version=1, **item.model_dump()
                    )
                )
                initialize(
                    conn, account, ItemOutput(id=event_id, version=1, **item.model_dump()), False
                )
                if current.item.type == "event":
                    conn.execute(
                        insert(branches).values(
                            child_id=event_id, parent_id=item_id, account=account
                        )
                    )
                origin = stored["candidates"][candidate.index]
                conn.execute(
                    insert(action_sources).values(
                        event_id=event_id,
                        run_id=run_id,
                        image_id=origin["image_id"],
                        evidence=origin["evidence"],
                    )
                )
                created.append(
                    {
                        "id": event_id,
                        "name": item.name,
                        "image_id": origin["image_id"],
                        "evidence": origin["evidence"],
                    }
                )
            conn.execute(
                update(action_runs)
                .where(action_runs.c.id == run_id)
                .values(confirmation=fingerprint, result=json.dumps({"created": created}))
            )
    return result(engine, account, item_id, run_id)


def origin(conn: Connection, account: str, event_id: str) -> dict[str, object] | None:
    """Return the original evidence and sign the image only while it remains accessible."""
    row = (
        conn.execute(
            select(action_sources.c.evidence, action_runs.c.item_id, images)
            .select_from(action_sources)
            .join(action_runs, action_runs.c.id == action_sources.c.run_id)
            .join(images, images.c.id == action_sources.c.image_id)
            .where(
                action_sources.c.event_id == event_id,
                action_runs.c.account == account,
                images.c.account == account,
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    value = {"name": row["name"], "evidence": row["evidence"], "url": ""}
    if row["state"] == "ready" and read_item(conn, account, str(row["item_id"])):
        value["url"] = configuration.storage(conn, account, str(row["profile_id"])).url(
            str(row["object_key"])
        )
    return value
