"""Validated source configuration contract."""

import re
from typing import Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class SourceInput(BaseModel):
    """One explicitly authorized source configuration."""

    id: UUID
    context: UUID | None = None
    kind: Literal["document", "chat"]
    address: str = Field(min_length=1, max_length=2048)
    interval: int = Field(default=900, ge=900, le=86400)
    enabled: bool = False
    removed: bool = False
    consent: bool = False
    ai_consent: bool = False
    expected_version: int | None = None

    @model_validator(mode="after")
    def validate_scope(self) -> "SourceInput":
        """Normalize links and reject unsupported access targets."""
        if self.enabled and (not self.consent or self.removed):
            raise ValueError("启用前需要确认读取范围")
        if self.kind == "chat":
            self.context = None
            if not re.fullmatch(r"oc_[a-zA-Z0-9]+", self.address):
                raise ValueError("请填写有效会话 ID")
        else:
            if self.context is None:
                raise ValueError("云文档必须指定事情或事件")
            url = urlsplit(self.address)
            if (
                url.scheme != "https"
                or url.username
                or url.password
                or url.port
                or not (url.hostname or "").endswith((".feishu.cn", ".larksuite.com"))
                or not re.fullmatch(r"/(wiki|docx)/[A-Za-z0-9]+/?", url.path)
            ):
                raise ValueError("请填写飞书 wiki/docx HTTPS 链接")
            self.address = urlunsplit((url.scheme, url.netloc, url.path, "", ""))
        return self
