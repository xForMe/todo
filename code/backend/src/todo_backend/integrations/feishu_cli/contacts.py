"""Minimal read-only contact projection for reminder recipient selection."""

import json
import re

from todo_backend.integrations.feishu_cli.reader import ReadFailure, run_read_command


def search_people(query: str, recipient: str = "") -> dict[str, object]:
    """Search one visible contact page or resolve one previously saved identity."""
    args = ["contact", "+search-user", "--as", "user", "--page-size", "20"]
    args += ["--user-ids", recipient] if recipient else ["--query", query]
    raw = run_read_command(args)
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise ValueError("invalid envelope")
        data = payload["data"]
        users = data["users"]
        if not isinstance(users, list) or len(users) > 20:
            raise ValueError("invalid users")
        people = []
        seen = set()
        for user in users:
            identity = user["open_id"]
            name = user["localized_name"]
            if not isinstance(identity, str) or not re.fullmatch(r"ou_[A-Za-z0-9]+", identity):
                raise ValueError("invalid identity")
            if not isinstance(name, str) or not name.strip() or name.startswith("ou_"):
                continue
            if recipient and identity != recipient:
                continue
            if identity in seen:
                continue
            seen.add(identity)
            person = {"id": identity, "name": name[:120]}
            for field in ("department", "enterprise_email"):
                value = user.get(field, "")
                if not isinstance(value, str):
                    raise ValueError("invalid display field")
                person[field] = value[:240]
            people.append(person)
        return {"people": people, "has_more": data.get("has_more") is True}
    except (ValueError, KeyError, TypeError) as exc:
        raise ReadFailure("人员查询返回结构无法识别，请重新查询") from exc
