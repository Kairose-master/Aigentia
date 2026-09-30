from collections.abc import Mapping
from typing import Any

from .types import (
    FacilitatorSupportedResponse,
    PaymentRequirements,
    PaymentVerifyResponse,
    SettlementResponse,
)

class FacilitatorClientOptions:
    base_url: str
    timeout_seconds: float
    def __init__(self, base_url: str, timeout_seconds: float = ...) -> None: ...

class AsyncFacilitatorClient:
    def __init__(
        self, options: FacilitatorClientOptions, *, headers: Mapping[str, str] | None = ...
    ) -> None: ...
    async def aclose(self) -> None: ...
    async def supported(self, *, x402_version: int = ...) -> FacilitatorSupportedResponse: ...
    async def verify(
        self,
        *,
        payment_header: str,
        payment_requirements: PaymentRequirements,
        extensions: Mapping[str, Any] | None = ...,
        x402_version: int = ...,
    ) -> PaymentVerifyResponse: ...
    async def settle(
        self,
        *,
        payment_header: str,
        payment_requirements: PaymentRequirements,
        extensions: Mapping[str, Any] | None = ...,
        x402_version: int = ...,
    ) -> SettlementResponse: ...
