"""Explicitly authorized private message sending and readback."""

import json
import os
import subprocess
from pathlib import Path


class SendFailure(Exception):
    """A possibly committed outbound operation; never automatically retry."""


def call_cli(args: list[str]) -> dict[str, object]:
    """Run a fixed native command once with a bounded timeout."""
    default = (
        Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@larksuite/cli/bin/lark-cli.exe"
    )
    exe = Path(os.environ.get("TODO_FEISHU_CLI_EXE", str(default)))
    if not exe.is_absolute() or not exe.is_file():
        raise SendFailure("CLI 未配置")
    try:
        result = subprocess.run(
            [str(exe), *args], shell=False, capture_output=True, timeout=45, check=False
        )
        if result.returncode or len(result.stdout) > 1_000_000:
            raise SendFailure("结果未知")
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise SendFailure("结果未知")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise SendFailure("结果未知")
        return {str(k): v for k, v in data.items()}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise SendFailure("结果未知") from exc


def send_message(recipient: str, content: str, operation_id: str) -> str:
    """Send as bot once and verify the returned message body by identifier."""
    sent = call_cli(
        [
            "im",
            "+messages-send",
            "--as",
            "bot",
            "--user-id",
            recipient,
            "--text",
            content,
            "--idempotency-key",
            operation_id,
        ]
    )
    mid = sent.get("message_id")
    if not isinstance(mid, str):
        raise SendFailure("发送结果缺少标识")
    read = call_cli(["im", "+messages-mget", "--as", "bot", "--message-ids", mid, "--no-reactions"])
    messages = read.get("messages")
    if not isinstance(messages, list) or not any(
        isinstance(m, dict) and m.get("message_id") == mid and m.get("content") == content
        for m in messages
    ):
        raise SendFailure("读回无法确认")
    return mid
