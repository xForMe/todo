"""Bounded input contracts for planning and explicit confirmation."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from todo_backend.modules.work.schemas import ItemInput


class TypeOutput(BaseModel):
    """Visible account-scoped prompt policy."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=36)
    name: str = Field(min_length=1, max_length=40)
    prompt: str = Field(min_length=1, max_length=4000)
    enabled: bool = True
    version: int = Field(ge=0)


class TypeWrite(BaseModel):
    """Versioned and replay-safe setting change."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    operation_id: UUID
    expected_version: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=40)
    prompt: str = Field(min_length=1, max_length=4000)
    enabled: bool = True


class GenerateInput(BaseModel):
    """Empty type requests model classification; no external source expansion."""

    model_config = ConfigDict(extra="forbid")
    snapshot: str = Field(min_length=64, max_length=64)
    type_id: str = Field(default="", max_length=36)
    instructions: str = Field(default="", max_length=2000)


class Classification(BaseModel):
    """Model selection must reference an enabled catalog member."""

    model_config = ConfigDict(extra="forbid")
    type_id: str = Field(max_length=36)


class ConfirmInput(BaseModel):
    """Only explicit selection creates business events."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    snapshot: str = Field(min_length=64, max_length=64)
    generation_id: UUID | None = None
    events: list[ItemInput] = Field(min_length=1, max_length=20)
