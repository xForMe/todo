"""Address and request boundaries for explicitly configured model services."""

import ipaddress
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from urllib.request import OpenerDirector, ProxyHandler, build_opener

from todo_backend.integrations.ai.embeddings import NoRedirect


@dataclass(frozen=True)
class ModelTarget:
    """Connection details for a single configured chat model."""

    base_url: str
    model: str
    key: str = field(repr=False)


def normalize_base_url(value: str) -> str:
    """Normalize a Chat Completions address and constrain its transport."""
    parts = urlsplit(value)
    host = parts.hostname or ""
    port = parts.port
    if (
        not value.isascii()
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
        or not host
        or parts.username is not None
        or parts.password is not None
        or any(char in value for char in ("?", "#", "\\"))
    ):
        raise ValueError("请填写不含密钥、查询参数或片段的模型地址")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
        if not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", host):
            raise ValueError("模型地址的主机名无效") from None
    loopback = host == "localhost" or bool(ip and ip.is_loopback)
    if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
        raise ValueError("请使用 HTTPS 模型地址，本机模型可使用回环 HTTP 地址")
    if port == 0 or (loopback and port == 8000):
        raise ValueError("请填写模型服务的有效端口")
    if ip and (ip.is_link_local or ip.is_unspecified or ip.is_multicast):
        raise ValueError("模型地址必须指向可访问的模型服务")
    path = parts.path.rstrip("/").removesuffix("/chat/completions")
    return parts._replace(netloc=parts.netloc.lower(), path=path).geturl()


def direct_opener() -> OpenerDirector:
    """Keep a custom model's data and key on the configured origin."""
    return build_opener(ProxyHandler({}), NoRedirect())
