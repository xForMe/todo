"""One-shot OpenAI/DashScope embeddings with explicit configuration and consent."""

import hashlib
import json
import math
import os
from dataclasses import dataclass, field
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class EmbeddingError(Exception):
    """A sanitized embedding failure, never a provider response or credential."""


class NoRedirect(HTTPRedirectHandler):
    """Reject redirects so credentials cannot be forwarded to another origin."""

    def redirect_request(
        self, req: Request, fp: object, code: int, msg: str, headers: object, newurl: str
    ) -> None:
        """Do not repeat the external request on redirect."""
        return None


@dataclass(frozen=True)
class EmbeddingConfig:
    """Fixed vector-space identity and provider endpoint."""

    endpoint: str
    model: str
    dimensions: int
    key: str = field(repr=False)
    revision: str
    protocol: str = "openai"

    @property
    def profile(self) -> str:
        """Separate models, endpoints, revisions and dimensions, excluding secrets."""
        value = json.dumps(
            [self.endpoint, self.model, self.dimensions, self.revision, self.protocol, "cosine-v1"]
        )
        return hashlib.sha256(value.encode()).hexdigest()


def configuration() -> EmbeddingConfig:
    """Fail closed until provider, dimension, key and explicit consent are supplied."""
    base = os.environ.get("EMBEDDING_BASE_URL", "")
    endpoint = os.environ.get(
        "TODO_EMBEDDING_URL", base.rstrip("/") + "/embeddings" if base else ""
    )
    model = os.environ.get("TODO_EMBEDDING_MODEL", os.environ.get("EMBEDDING_MODEL", ""))
    parsed = urlparse(endpoint)
    protocol = "openai"
    if (
        model == "qwen3-vl-embedding"
        and parsed.hostname
        and parsed.hostname.endswith(".maas.aliyuncs.com")
    ):
        protocol = "dashscope"
        endpoint = parsed._replace(
            path="/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
        ).geturl()
    try:
        dimensions = int(
            os.environ.get(
                "TODO_EMBEDDING_DIMENSIONS", "2560" if model == "qwen3-vl-embedding" else "0"
            )
        )
    except ValueError as exc:
        raise EmbeddingError("向量维度配置无效") from exc
    if (
        os.environ.get("TODO_EMBEDDING_CONSENT") != "1"
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not 1 <= dimensions <= 4096
    ):
        raise EmbeddingError("向量服务未完整配置或未授权，精确匹配仍可用")
    key = os.environ.get("TODO_EMBEDDING_KEY", os.environ.get("EMBEDDING_API_KEY", ""))
    revision = os.environ.get("TODO_EMBEDDING_REVISION", "local-generation-1")
    if not model or not key or not revision:
        raise EmbeddingError("请配置向量模型、修订标识及密钥")
    return EmbeddingConfig(endpoint, model, dimensions, key, revision, protocol)


def validate_vector(value: object, dimensions: int) -> list[float]:
    """Reject malformed, nonfinite, zero or wrong-dimension embeddings."""
    if not isinstance(value, list) or len(value) != dimensions:
        raise EmbeddingError("向量维度与配置不符")
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int | float):
            raise EmbeddingError("向量响应无效")
        number = float(item)
        if not math.isfinite(number) or abs(number) > 1e10:
            raise EmbeddingError("向量响应无效")
        result.append(number)
    if not any(result):
        raise EmbeddingError("向量不能为零")
    return result


def embed(content: str, config: EmbeddingConfig) -> list[float]:
    """Submit once; never retry or persist query text."""
    if not content or len(content) > 6000:
        raise EmbeddingError("向量输入为空或超出上限")
    payload: dict[str, object] = {"model": config.model, "input": content}
    if config.protocol == "dashscope":
        payload["input"] = {"contents": [{"text": content}]}
        payload["parameters"] = {"dimension": config.dimensions}
    request = Request(
        config.endpoint,
        json.dumps(payload).encode(),
        {"Authorization": "Bearer " + config.key, "Content-Type": "application/json"},
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise EmbeddingError("向量响应超出上限")
        body = json.loads(raw)
        values = body["output"]["embeddings"] if config.protocol == "dashscope" else body["data"]
        if len(values) != 1:
            raise EmbeddingError("向量响应数量无效")
        return validate_vector(values[0]["embedding"], config.dimensions)
    except (HTTPError, URLError, OSError, TimeoutError) as exc:
        raise EmbeddingError("向量请求失败或结果未知，未自动重试") from exc
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise EmbeddingError("向量响应格式无效") from exc
