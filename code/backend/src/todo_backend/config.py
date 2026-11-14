"""Load a small allowlisted local configuration without exposing secrets."""

import os
from pathlib import Path


def load_local_config() -> None:
    """Read code/.env; inherited environment takes precedence, no interpolation."""
    path = Path(__file__).resolve().parents[3] / ".env"
    if not path.is_file():
        return
    allowed = {
        "TODO_UAIAPI_KEY",
        "TODO_AI_MODEL",
        "TODO_FEISHU_CLI_EXE",
        "TODO_DATABASE_URL",
        "TODO_DB_HOST",
        "TODO_DB_PORT",
        "TODO_DB_NAME",
        "TODO_DB_USER",
        "TODO_DB_SSLMODE",
        "DB_PASSWORD",
        "db_password",
    }
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        name, separator, value = line.strip().partition("=")
        if separator and name.strip() in allowed:
            os.environ.setdefault(name.strip().upper(), value.strip().strip("\"'"))
