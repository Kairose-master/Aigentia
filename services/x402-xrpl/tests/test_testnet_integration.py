"""Opt-in real XRPL Testnet round trip: faucet -> /payer/build -> sign -> /verify -> /settle.

Run with:  X402_TESTNET_INTEGRATION=1 .venv/bin/pytest -q -s tests/test_testnet_integration.py
Seeds stay inside the process and are never printed.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from xrpl.wallet import Wallet

from app.main import create_app
from app.settings import DEFAULT_RPC_URL
from tests.conftest import AUTH, make_settings, payload, requirements, sign_unsigned, verify_body

pytestmark = pytest.mark.skipif(
    os.environ.get("X402_TESTNET_INTEGRATION") != "1",
    reason="set X402_TESTNET_INTEGRATION=1 to run against XRPL Testnet",
)

FAUCET_URL = os.environ.get("XRPL_FAUCET_URL", "https://faucet.altnet.rippletest.net/accounts")
RPC_URL = os.environ.get("XRPL_RPC_URL", DEFAULT_RPC_URL)
FUND_TIMEOUT_SECONDS = 120


def _rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    resp = httpx.post(RPC_URL, json={"method": method, "params": [params]}, timeout=30)
    resp.raise_for_status()
    result: dict[str, Any] = resp.json()["result"]
    return result


def _fund(address: str) -> None:
    resp = httpx.post(FAUCET_URL, json={"destination": address}, timeout=60)
    assert resp.status_code in (200, 201), f"faucet HTTP {resp.status_code}"
    deadline = time.time() + FUND_TIMEOUT_SECONDS
    while time.time() < deadline:
        info = _rpc("account_info", {"account": address, "ledger_index": "validated"})
        if info.get("status") == "success":
            return
        time.sleep(3)
    raise AssertionError(f"faucet did not fund {address} in time")


def test_testnet_round_trip() -> None:
    payer = Wallet.create()
    seller = Wallet.create()
    _fund(payer.classic_address)
    _fund(seller.classic_address)

    settings = make_settings(rpc_url=RPC_URL, settle_poll_seconds=1.0, log_level="INFO")
    with TestClient(create_app(settings)) as client:
        health = client.get("/health").json()
        assert health["ok"] is True and health["networkId"] == 1

        reqs = requirements(
            seller.classic_address, amount="1000", invoice_id=f"it-{int(time.time())}"
        )
        build = client.post(
            "/payer/build",
            json={"account": payer.classic_address, "paymentRequirements": reqs},
            headers=AUTH,
        )
        assert build.status_code == 200, build.text
        built = build.json()
        blob = sign_unsigned(built["unsignedTx"], payer)
        body = verify_body(payload(blob, reqs), reqs)

        verified = client.post("/verify", json=body, headers=AUTH).json()
        assert verified == {"isValid": True, "payer": payer.classic_address}, verified

        settled = client.post("/settle", json=body, headers=AUTH).json()
        assert settled["success"] is True, settled
        tx_hash = settled["transaction"]
        assert settled["extensions"]["deliveredAmount"] == "1000"

        again = client.post("/settle", json=body, headers=AUTH).json()
        assert again["success"] is True and again["transaction"] == tx_hash

        status = client.get(f"/tx/{tx_hash}", headers=AUTH).json()
        assert status["validated"] is True and status["result"] == "tesSUCCESS"
        assert status["destination"] == seller.classic_address

    on_ledger = _rpc("tx", {"transaction": tx_hash})
    assert on_ledger["validated"] is True
    assert on_ledger["meta"]["TransactionResult"] == "tesSUCCESS"
    print(
        f"\nTESTNET_TX_HASH={tx_hash} payer={payer.classic_address} seller={seller.classic_address}"
    )
