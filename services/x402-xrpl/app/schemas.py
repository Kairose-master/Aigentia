"""Request models for the routes that take a strictly-shaped body."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ResourceInfoModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str = Field(min_length=1)
    description: str | None = None
    mimeType: str | None = None


class PayerBuildRequest(BaseModel):
    """Body of POST /payer/build (mirrors packages/protocol payerBuildRequestSchema)."""

    model_config = ConfigDict(extra="forbid")

    account: str = Field(min_length=25, max_length=35)
    paymentRequirements: dict[str, Any]
    resource: ResourceInfoModel | None = None
    maxFeeDrops: int = Field(default=10_000, ge=1)
