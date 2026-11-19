"""Read-only native Feishu CLI adapter with bounded execution."""

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path


class ReadFailure(Exception):
    """A safe source read failure."""


def read_source(kind: str, address: str) -> str:
    """Read a document or one bounded chat page without shell execution."""
    args = (
        ["docs", "+fetch", "--as", "user", "--doc", address]
        if kind == "document"
        else [
            "im",
            "+chat-messages-list",
            "--as",
            "user",
            "--chat-id",
            address,
            "--page-size",
            "20",
            "--no-reactions",
        ]
    )
    raw = run_read_command(args)
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise ValueError("invalid envelope")
        data = payload["data"]
        if not isinstance(data, dict):
            raise ValueError("invalid data")
        if kind == "document":
            content = data["document"]["content"]
            if not isinstance(content, str):
                raise ValueError("invalid document")
            return content
        messages = data["messages"]
        if not isinstance(messages, list):
            raise ValueError("invalid messages")
        return (
            "部分结果：仅当前最新一页\n" if data.get("has_more") else "当前页完整\n"
        ) + json.dumps(messages, ensure_ascii=False, indent=2)
    except (ValueError, KeyError, TypeError) as exc:
        raise ReadFailure("飞书返回结构无法识别") from exc


def run_read_command(args: list[str]) -> bytes:
    """Execute a fixed read-only CLI command with timeout and output bounds."""
    default = (
        Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@larksuite/cli/bin/lark-cli.exe"
    )
    exe = Path(os.environ.get("TODO_FEISHU_CLI_EXE", str(default)))
    if not exe.is_absolute() or not exe.is_file():
        raise ReadFailure("未配置可信的飞书 CLI 可执行文件")
    env = {
        **os.environ,
        "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
        "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1",
    }
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(
                [str(exe), *args], stdout=output, stderr=errors, env=env, shell=False
            )
        except OSError as exc:
            raise ReadFailure("无法启动飞书 CLI") from exc
        deadline = time.monotonic() + 45
        while process.poll() is None:
            if (
                time.monotonic() > deadline
                or max(os.fstat(output.fileno()).st_size, os.fstat(errors.fileno()).st_size)
                > 2_000_000
            ):
                process.kill()
                process.wait()
                raise ReadFailure("读取超时或内容过大，已暂停")
            time.sleep(0.05)
        if process.returncode != 0:
            raise ReadFailure("飞书读取失败，请核对授权与资源权限后恢复")
        output.seek(0)
        raw = output.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ReadFailure("内容超过读取上限")
    return raw
