"""Strict input contracts; secrets are write-only."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class StorageInput(BaseModel):
    """Save one complete, versioned storage profile."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision: int = Field(ge=0)
    region: str = Field(pattern=r"^[a-z]{2}-[a-z]+(?:-[a-z]+)?$", max_length=50)
    bucket: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*-[0-9]+$", max_length=100)
    secret_id: SecretStr | None = None
    secret_key: SecretStr | None = None


class RemoveInput(BaseModel):
    """Explicitly remove an association without deleting its cloud object."""

    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    expected_revision: int = Field(ge=1)
