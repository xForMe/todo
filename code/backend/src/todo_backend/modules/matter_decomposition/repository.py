"""Scoped planning settings and immutable generation provenance."""

from sqlalchemy import Boolean, Column, Integer, String, Table, Text, select
from sqlalchemy.engine import Connection

from todo_backend.modules.matter_decomposition.schemas import TypeOutput
from todo_backend.modules.work.repository import metadata

types = Table(
    "decomposition_types",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("name", String(40), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("version", Integer, nullable=False),
)
runs = Table(
    "decomposition_runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("matter_id", String(36), nullable=False),
    Column("snapshot", String(64), nullable=False),
    Column("basis", Text, nullable=False),
)
DEFAULTS = [
    (
        "feature",
        "功能交付",
        "围绕功能交付拆解关键节点：原型评审、技术方案评审、发版、现场验证。"
        "结合已有进展跳过或补充，不强制四项。不要将尚未提到的开发测试当成已完成。",
    ),
    (
        "issue",
        "问题排查",
        "围绕现象与证据收集、原因定位、处理问题、结果验证拆解。不把待验证原因当成事实。",
    ),
    ("site", "现场实施", "围绕现场条件核对、实施准备、联调、交付验证拆解。未知条件待确认。"),
    (
        "research",
        "调研分析",
        "围绕明确问题、收集资料、比较方案、形成结论拆解。缺乏依据时安排验证。",
    ),
    ("general", "通用", "围绕预期结果拆出少量可执行行动，不强制套用研发流程，信息不足说明假设。"),
]


def list_types(conn: Connection, account: str) -> list[TypeOutput]:
    """Overlay account settings without writing defaults on a read."""
    values = {
        key: TypeOutput(id=key, name=name, prompt=prompt, enabled=True, version=0)
        for key, name, prompt in DEFAULTS
    }
    for row in conn.execute(select(types).where(types.c.account == account)).mappings():
        values[row["id"]] = TypeOutput.model_validate(
            {k: v for k, v in row.items() if k != "account"}
        )
    return list(values.values())
