from collections.abc import Mapping, Sequence
from typing import Any

class ResourceInfo:
    url: str
    description: str | None
    mime_type: str | None
    def __init__(
        self, url: str, description: str | None = ..., mime_type: str | None = ...
    ) -> None: ...
    def to_dict(self) -> dict[str, Any]: ...
    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ResourceInfo: ...

class PaymentRequirements:
    scheme: str
    network: str
    amount: str
    asset: str
    pay_to: str
    max_timeout_seconds: int
    extra: Mapping[str, Any] | None
    def __init__(
        self,
        scheme: str,
        network: str,
        amount: str,
        asset: str,
        pay_to: str,
        max_timeout_seconds: int,
        extra: Mapping[str, Any] | None = ...,
    ) -> None: ...
    def to_dict(self) -> dict[str, Any]: ...
    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> PaymentRequirements: ...
    def invoice_id(self) -> str | None: ...

class PaymentPayload:
    x402_version: int
    resource: ResourceInfo | None
    accepted: PaymentRequirements
    payload: Mapping[str, Any]
    extensions: Mapping[str, Any] | None
    def __init__(
        self,
        x402_version: int,
        resource: ResourceInfo | None,
        accepted: PaymentRequirements,
        payload: Mapping[str, Any],
        extensions: Mapping[str, Any] | None = ...,
    ) -> None: ...
    def to_dict(self) -> dict[str, Any]: ...
    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> PaymentPayload: ...

class FacilitatorKind:
    x402_version: int
    scheme: str
    network: str

class FacilitatorSupportedResponse:
    kinds: Sequence[FacilitatorKind]
    extensions: Sequence[str]
    signers: Mapping[str, Sequence[str]]
    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> FacilitatorSupportedResponse: ...

class PaymentVerifyResponse:
    is_valid: bool
    invalid_reason: str | None
    payer: str | None
    extensions: Mapping[str, Any] | None
    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> PaymentVerifyResponse: ...

class SettlementResponse:
    success: bool
    transaction: str
    network: str
    payer: str | None
    error_reason: str | None
    extensions: Mapping[str, Any] | None
    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> SettlementResponse: ...
    def to_dict(self) -> dict[str, Any]: ...
