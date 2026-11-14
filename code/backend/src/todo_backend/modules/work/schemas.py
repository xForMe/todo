"""Validated transport contracts."""

from datetime import date, datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ItemInput(BaseModel):
    """User-editable fields with explicit immutable hierarchy."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    type: Literal["goal", "module", "thing", "event"]
    parent: str | None = None
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=10000)
    owner: str = Field(default="", max_length=80)
    planStart: str = ""
    planEnd: str = ""
    status: Literal["notStarted", "working", "completed", "cancelled"] = "notStarted"

    @model_validator(mode="after")
    def validate_plan(self) -> Self:
        """Validate calendar dates and restrict action metadata."""
        for value in (self.planStart, self.planEnd):
            if value and (len(value) != 10 or date.fromisoformat(value).isoformat() != value):
                raise ValueError("计划日期须为 YYYY-MM-DD，不包含时分")
        if (
            self.planStart
            and self.planEnd
            and date.fromisoformat(self.planEnd) < date.fromisoformat(self.planStart)
        ):
            raise ValueError("计划结束时间不能早于开始时间")
        if self.type in ("goal", "module") and (
            self.owner or self.planStart or self.planEnd or self.status != "notStarted"
        ):
            raise ValueError("目标和模块不接受行动字段")
        return self


class WriteInput(ItemInput):
    """Mutation envelope with replay and concurrency controls."""

    operation_id: UUID
    expected_version: int | None = Field(default=None, ge=1)


class ItemOutput(ItemInput):
    """Stored object returned to the client."""

    id: str
    version: int

    @field_validator("planStart", "planEnd", mode="before")
    @classmethod
    def legacy_date(cls, value: str) -> str:
        """Read old local timestamps as dates without modifying stored records."""
        if value and len(value) > 10:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is not None:
                raise ValueError("历史计划时间不能包含时区")
            return parsed.date().isoformat()
        return value
