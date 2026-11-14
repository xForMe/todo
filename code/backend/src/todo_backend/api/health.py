"""Process liveness, without claiming dependency readiness."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/health", tags=["health"])


class LivenessResponse(BaseModel):
    """Describe application liveness only."""

    status: Literal["ok"] = "ok"


@router.get("/live", response_model=LivenessResponse)
def liveness() -> LivenessResponse:
    """Report that the application can handle a request."""
    return LivenessResponse()
