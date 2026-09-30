"""X402_FACILITATOR_MODE=remote: local fail-closed pre-checks, then proxy via the SDK client."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from x402_xrpl.types import PaymentRequirements, PaymentVerifyResponse, SettlementResponse
from xrpl.wallet import Wallet

from app.main import create_app
from tests.conftest import (
    AUTH,
    FakeRpcClient,
    build_sign,
    make_settings,
    payload,
    requirements,
    verify_body,
)


class StubFacilitatorClient:
    """Stands in for x402_xrpl.facilitator.AsyncFacilitatorClient."""

    def __init__(self) -> None:
        self.verify_calls: list[tuple[str, PaymentRequirements]] = []
        self.settle_calls: list[tuple[str, PaymentRequirements]] = []
        self.fail_with: Exception | None = None

    async def aclose(self) -> None:
        return None

    async def verify(
        self, *, payment_header: str, payment_requirements: PaymentRequirements, **_: Any
    ) -> PaymentVerifyResponse:
        self.verify_calls.append((payment_header, payment_requirements))
        if self.fail_with:
            raise self.fail_with
        return PaymentVerifyResponse.from_wire({"isValid": True, "payer": "rREMOTE"})

    async def settle(
        self, *, payment_header: str, payment_requirements: PaymentRequirements, **_: Any
    ) -> SettlementResponse:
        self.settle_calls.append((payment_header, payment_requirements))
        if self.fail_with:
            raise self.fail_with
        return SettlementResponse.from_wire(
            {"success": True, "transaction": "A" * 64, "network": "xrpl:1", "payer": "rREMOTE"}
        )


@pytest.fixture
def remote(
    rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> Iterator[tuple[TestClient, StubFacilitatorClient]]:
    rpc.fund(payer.classic_address)
    rpc.fund(seller.classic_address)
    settings = make_settings(
        facilitator_mode="remote", facilitator_url="http://facilitator.invalid"
    )
    app = create_app(settings, rpc_client=rpc)
    with TestClient(app) as client:
        stub = StubFacilitatorClient()
        app.state.facilitator._client = stub
        assert client.get("/health").json()["facilitatorMode"] == "remote"
        yield client, stub


def test_remote_proxies_after_local_checks(
    remote: tuple[TestClient, StubFacilitatorClient], payer: Wallet, seller: Wallet
) -> None:
    client, stub = remote
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    body = verify_body(payload(blob, reqs), reqs)

    assert client.post("/verify", json=body, headers=AUTH).json() == {
        "isValid": True,
        "payer": "rREMOTE",
    }
    settled = client.post("/settle", json=body, headers=AUTH).json()
    assert settled["success"] is True and settled["transaction"] == "A" * 64
    assert len(stub.verify_calls) == 1 and len(stub.settle_calls) == 1
    header, forwarded = stub.verify_calls[0]
    assert forwarded.pay_to == seller.classic_address
    envelope = json.loads(base64.b64decode(header))
    assert envelope["payload"]["invoiceId"] == "inv-0001"
    assert envelope["accepted"]["payTo"] == seller.classic_address


def test_remote_still_refuses_locally(
    remote: tuple[TestClient, StubFacilitatorClient], payer: Wallet, seller: Wallet
) -> None:
    client, stub = remote
    blob, _ = build_sign(client, payer, requirements(seller.classic_address))
    mainnet = requirements(seller.classic_address, network="xrpl:0")
    body = verify_body(payload(blob, mainnet), mainnet)
    assert (
        client.post("/verify", json=body, headers=AUTH).json()["invalidReason"] == "mainnet_refused"
    )
    assert (
        client.post("/settle", json=body, headers=AUTH).json()["errorReason"] == "mainnet_refused"
    )
    assert stub.verify_calls == [] and stub.settle_calls == []


def test_remote_transport_failures_fail_closed(
    remote: tuple[TestClient, StubFacilitatorClient], payer: Wallet, seller: Wallet
) -> None:
    client, stub = remote
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    body = verify_body(payload(blob, reqs), reqs)

    stub.fail_with = httpx.ConnectError("down")
    assert client.post("/verify", json=body, headers=AUTH).json() == {
        "isValid": False,
        "invalidReason": "facilitator_unavailable",
    }
    settled = client.post("/settle", json=body, headers=AUTH).json()
    assert settled["success"] is False
    assert settled["errorReason"] == "facilitator_unavailable"
    assert settled["transaction"] == ""

    stub.fail_with = httpx.ReadTimeout("slow")
    settled = client.post("/settle", json=body, headers=AUTH).json()
    assert settled["errorReason"] == "settlement_status_unknown"
    assert len(settled["extensions"]["transactionHash"]) == 64
