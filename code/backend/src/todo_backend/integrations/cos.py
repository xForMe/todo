"""Tencent COS boundary: HTTPS, private objects and zero implicit retries."""

import logging
from contextlib import closing
from typing import Protocol, cast

from qcloud_cos import CosConfig, CosS3Client
from qcloud_cos.cos_exception import CosClientError, CosServiceError
from requests import RequestException
from urllib3.exceptions import HTTPError

from todo_backend.modules.work.service import WorkError


class CosClient(Protocol):
    """The small subset of the untyped vendor SDK used by this application."""

    def put_object(self, **kwargs: object) -> dict[str, object]:
        """Upload a single object."""
        ...

    def head_object(self, **kwargs: object) -> dict[str, object]:
        """Read stored metadata."""
        ...

    def get_object(self, **kwargs: object) -> dict[str, object]:
        """Open a private object stream."""
        ...

    def head_bucket(self, **kwargs: object) -> dict[str, object]:
        """Check bucket access without modifying it."""
        ...

    def get_presigned_url(self, **kwargs: object) -> str:
        """Sign a short-lived GET without issuing a network request."""
        ...


class Storage:
    """Provide single-attempt object writes and scoped reads."""

    def __init__(self, region: str, bucket: str, secret_id: str, secret_key: str) -> None:
        """Keep the SDK isolated and disable redirects and retry behavior."""
        # Vendor debug output includes signing keys; application errors are sanitized separately.
        for name in ("qcloud_cos.cos_auth", "qcloud_cos.cos_client"):
            logging.getLogger(name).disabled = True
        self.bucket = bucket
        self.client = cast(
            CosClient,
            CosS3Client(
                CosConfig(
                    Region=region,
                    SecretId=secret_id,
                    SecretKey=secret_key,
                    Scheme="https",
                    Timeout=30,
                    AllowRedirects=False,
                ),
                retry=0,
            ),
        )

    def put(self, key: str, data: bytes, mime: str, sha256: str) -> None:
        """Write exactly once; uncertain failures must be reconciled separately."""
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType=mime,
                ACL="private",
                Metadata={"x-cos-meta-sha256": sha256},
            )
        except (CosClientError, CosServiceError, RequestException) as exc:
            raise WorkError(502, "图片上传结果待核对，请勿重复上传") from exc

    def head(self, key: str) -> dict[str, object] | None:
        """Return absent only for a definite 404; never disguise denied access."""
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except CosServiceError as exc:
            if exc.get_status_code() == 404:
                return None
            raise WorkError(502, "无法核对云端图片，请检查存储权限或稍后核对") from exc
        except (CosClientError, RequestException) as exc:
            raise WorkError(502, "无法连接图片存储，请稍后核对") from exc

    def check(self) -> None:
        """Only prove HEAD Bucket access, not upload or download permissions."""
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except (CosClientError, CosServiceError, RequestException) as exc:
            raise WorkError(502, "存储桶访问检查失败，请核对地域、桶名及密钥权限") from exc

    def read(self, key: str, limit: int) -> bytes:
        """Read only the expected number of bytes plus an overflow sentinel."""
        try:
            body = cast(CosBody, self.client.get_object(Bucket=self.bucket, Key=key)["Body"])
            with closing(body.get_raw_stream()) as stream:
                return stream.read(limit + 1)
        except (CosClientError, CosServiceError, RequestException, HTTPError, OSError) as exc:
            raise WorkError(502, "读取私有图片失败，请检查COS下载权限后重试") from exc

    def url(self, key: str) -> str:
        """Issue a five-minute private GET link."""
        return self.client.get_presigned_url(Method="GET", Bucket=self.bucket, Key=key, Expired=300)


class ObjectStream(Protocol):
    """Minimal bounded SDK stream interface."""

    def read(self, amt: int) -> bytes:
        """Read bytes from the stream."""
        ...

    def close(self) -> None:
        """Release the response connection."""
        ...


class CosBody(Protocol):
    """Tencent SDK response wrapper."""

    def get_raw_stream(self) -> ObjectStream:
        """Return the response stream."""
        ...
