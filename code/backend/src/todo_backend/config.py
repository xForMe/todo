"""Load a small allowlisted local configuration without exposing secrets."""

import os
from pathlib import Path


def load_local_config() -> None:
    """Read code/.env; inherited environment takes precedence, no interpolation."""
    path = Path(__file__).resolve().parents[3] / ".env"
    if not path.is_file():
        return
    allowed = {
        "TODO_STORAGE_ENCRYPTION_KEY",
        "TODO_UAIAPI_KEY",
        "TODO_AI_MODEL",
        "TODO_VISION_MODEL",
        "TODO_VISION_API_KEY",
        "TODO_FEISHU_CLI_EXE",
        "TODO_DSH_CAPTURE_TOKEN",
        "TODO_DSH_DIRECT_TOKEN",
        "TODO_DSH_CAPTURE_MODEL_ID",
        "TODO_DSH_EVENT_LOOKUP",
        "TODO_DSH_EVENT_EMBEDDING_CONSENT",
        "TODO_DSH_EVENT_VECTOR_CALIBRATION",
        "TODO_DATABASE_URL",
        "TODO_DB_HOST",
        "TODO_DB_PORT",
        "TODO_DB_NAME",
        "TODO_DB_USER",
        "TODO_DB_SSLMODE",
        "DB_PASSWORD",
        "db_password",
        "TODO_MEMORY_ENABLED",
        "TODO_EMBEDDING_URL",
        "TODO_EMBEDDING_MODEL",
        "TODO_EMBEDDING_KEY",
        "TODO_EMBEDDING_DIMENSIONS",
        "TODO_EMBEDDING_REVISION",
        "TODO_EMBEDDING_CONSENT",
        "TODO_EMBEDDING_SOURCE_CONSENT",
        "EMBEDDING_BASE_URL",
        "EMBEDDING_MODEL",
        "EMBEDDING_API_KEY",
    }
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        name, separator, value = line.strip().partition("=")
        if separator and name.strip() in allowed:
            os.environ.setdefault(name.strip().upper(), value.strip().strip("\"'"))
