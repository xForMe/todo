"""Bounded, explicitly confirmed module memory contracts."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CardInput(BaseModel):
    """Replace one module card after the user reviews its current scope."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_version: int = Field(ge=0)
    scope_version: str = Field(min_length=64, max_length=64)
    description: str = Field(max_length=2000)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    enabled: bool = True
    candidate_id: UUID | None = None

    @field_validator("description")
    @classmethod
    def trim_description(cls, value: str) -> str:
        """Keep the confirmed text without surrounding whitespace."""
        return value.strip()

    @field_validator("aliases")
    @classmethod
    def check_aliases(cls, values: list[str]) -> list[str]:
        """Reject empty, duplicate or oversized aliases instead of truncating."""
        normalized = [value.strip() for value in values]
        if any(not value or len(value) > 80 for value in normalized):
            raise ValueError("简称须为1至80字")
        if len(set(normalized)) != len(normalized):
            raise ValueError("简称不能重复")
        return normalized


class IndexInput(BaseModel):
    """Authorize one non-retried indexing attempt for an exact card revision."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_version: int = Field(ge=1)


class CardOutput(BaseModel):
    """Current editable card, with stale scope made visible."""

    module_id: str
    path: str
    scope_version: str
    version: int
    description: str
    aliases: list[str]
    enabled: bool
    usable: bool
    status: str


class MemoryContext(BaseModel):
    """Bounded evidence sent to recognition, with a freshness fingerprint."""

    text: str = ""
    fingerprint: str = ""
    status: str = "disabled"


class WorkingAction(BaseModel):
    """A referenced, bounded excerpt of an unfinished business event."""

    id: str
    version: int
    name: str
    status: str
    owner: str
    plan_end: str


class WorkingSummary(BaseModel):
    """Current facts with counts distinguishing omitted work from absent work."""

    thing_id: str
    thing_version: int
    path: str
    status: str
    counts: dict[str, int]
    actions: list[WorkingAction]
    omitted: int
    partial: bool


class WorkingOutput(BaseModel):
    """Cache outcome and freshness of the derived summary, never a business update."""

    thing_id: str
    state: str
    fingerprint: str
    generated_at: int
    summary: WorkingSummary | None = None
