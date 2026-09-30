from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from xrpl.core.binarycodec import decode
from xrpl.models.transactions.transaction import Transaction
from xrpl.wallet import Wallet

from app.rpc import tx_hash_from_blob
from tests.conftest import AUTH, FakeRpcClient, build_sign, payload, requirements, verify_body


def settle(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    resp = client.post("/settle", json=body, headers=AUTH)
    assert resp.status_code == 200, resp.text
    out: dict[str, Any] = resp.json()
    return out


def test_settle_happy_path_and_hash(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    expected_hash = Transaction.from_xrpl(decode(blob)).get_hash()
    assert tx_hash_from_blob(blob) == expected_hash

    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out["success"] is True
    assert out["transaction"] == expected_hash
    assert out["network"] == "xrpl:1"
    assert out["payer"] == payer.classic_address
    assert out["extensions"]["ledgerIndex"] == rpc.validated_ledger
    assert out["extensions"]["deliveredAmount"] == "1000"
    assert out["extensions"]["closeTime"] == "2026-09-30T12:00:00Z"
    assert len(rpc.submissions) == 1

    status = client.get(f"/tx/{expected_hash}", headers=AUTH)
    assert status.status_code == 200
    body = status.json()
    assert body["found"] is True
    assert body["validated"] is True
    assert body["result"] == "tesSUCCESS"
    assert body["ledgerIndex"] == rpc.validated_ledger
    assert body["deliveredAmount"] == "1000"
    assert body["account"] == payer.classic_address
    assert body["destination"] == seller.classic_address
    assert body["closeTime"] == "2026-09-30T12:00:00Z"


def test_settle_is_idempotent(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, unsigned = build_sign(client, payer, reqs)
    first = settle(client, verify_body(payload(blob, reqs), reqs))
    assert first["success"] is True

    # Even after the quote would have expired and the sequence was consumed, the same
    # blob resolves to the same validated transaction without a second submit.
    rpc.advance(unsigned["LastLedgerSequence"] + 100)
    second = settle(client, verify_body(payload(blob, reqs), reqs))
    assert second["success"] is True
    assert second["transaction"] == first["transaction"]
    assert len(rpc.submissions) == 1


def test_settle_invalid_payment_does_not_submit(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    other = Wallet.create()
    blob, _ = build_sign(client, payer, requirements(other.classic_address))
    reqs = requirements(seller.classic_address)
    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out == {
        "success": False,
        "errorReason": "destination_mismatch",
        "transaction": "",
        "network": "xrpl:1",
        "payer": payer.classic_address,
    }
    assert rpc.submissions == []


def test_settle_reports_tec_failure(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    rpc.submit_engine_result = "tecUNFUNDED_PAYMENT"
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out["success"] is False
    assert out["errorReason"] == "tecUNFUNDED_PAYMENT"
    assert out["transaction"] == ""
    assert out["extensions"]["transactionHash"] == tx_hash_from_blob(blob)


def test_settle_tem_fails_immediately(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    rpc.submit_engine_result = "temBAD_FEE"
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out["success"] is False
    assert out["errorReason"] == "temBAD_FEE"
    assert len(rpc.submissions) == 1


def test_settle_expired_before_validation(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    rpc.validate_on_submit = False
    rpc.advance_per_ledger_query = 10
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out["success"] is False
    assert out["errorReason"] == "expired_before_validation"
    assert out["transaction"] == ""
    assert out["extensions"]["transactionHash"] == tx_hash_from_blob(blob)
    assert out["extensions"]["preliminaryResult"] == "tesSUCCESS"


def test_settle_waits_for_queued_tx(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    rpc.validate_on_submit = False
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)

    original = rpc._request_impl

    async def request_then_validate(request: Any, *, timeout: float = 10.0) -> Any:
        response = await original(request, timeout=timeout)
        if str(request.to_dict()["method"]) == "tx" and rpc.txs:
            rpc.validate_pending()
        return response

    rpc._request_impl = request_then_validate  # type: ignore[method-assign]
    out = settle(client, verify_body(payload(blob, reqs), reqs))
    assert out["success"] is True
    assert out["transaction"] == tx_hash_from_blob(blob)


def test_tx_lookup_errors(client: TestClient) -> None:
    unknown = client.get(f"/tx/{'A' * 64}", headers=AUTH)
    assert unknown.status_code == 404
    assert unknown.json() == {"found": False, "error": "tx_not_found"}

    bad = client.get("/tx/not-a-hash", headers=AUTH)
    assert bad.status_code == 400
    assert bad.json() == {"error": "invalid_tx_hash"}
