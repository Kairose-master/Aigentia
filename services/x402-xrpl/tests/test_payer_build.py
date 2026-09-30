from __future__ import annotations

import math
from typing import Any

from fastapi.testclient import TestClient
from x402_xrpl.client.presigned_payment_payer import (
    FACILITATOR_MEMO_TYPE,
    invoice_id_to_invoice_id_field,
    invoice_id_to_memo_hex,
    text_to_memo_hex,
)
from xrpl.core.binarycodec import decode
from xrpl.wallet import Wallet

from tests.conftest import (
    AUTH,
    SOURCE_TAG,
    FakeRpcClient,
    build_unsigned,
    payload,
    requirements,
    sign_unsigned,
    verify_body,
)


def test_build_output_shape(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    ledger_before = rpc.validated_ledger
    reqs = requirements(
        seller.classic_address,
        extra={"facilitator": {"id": "aigentia-facilitator", "name": "Aigentia"}},
    )
    built = build_unsigned(client, payer.classic_address, reqs)
    assert built["invoiceId"] == "inv-0001"
    assert built["networkId"] == 1
    expected_lls = ledger_before + math.ceil(120 / 5) + 2
    assert built["lastLedgerSequence"] == expected_lls

    tx = built["unsignedTx"]
    assert tx["TransactionType"] == "Payment"
    assert tx["Account"] == payer.classic_address
    assert tx["Destination"] == seller.classic_address
    assert tx["Amount"] == "1000"
    assert tx["Fee"] == "10"
    assert tx["Sequence"] == 1
    assert tx["LastLedgerSequence"] == expected_lls
    assert tx["SourceTag"] == SOURCE_TAG
    assert tx["InvoiceID"] == invoice_id_to_invoice_id_field("inv-0001")
    assert "SigningPubKey" not in tx
    assert "TxnSignature" not in tx
    assert "NetworkID" not in tx
    memos = tx["Memos"]
    assert memos[0] == {"Memo": {"MemoData": invoice_id_to_memo_hex("inv-0001")}}
    assert memos[1]["Memo"]["MemoType"] == text_to_memo_hex(FACILITATOR_MEMO_TYPE)
    assert memos[1]["Memo"]["MemoData"] == text_to_memo_hex(
        '{"id":"aigentia-facilitator","name":"Aigentia","sourceTag":804681468}'
    )


def test_build_signs_cleanly_and_verifies(
    client: TestClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    built = build_unsigned(client, payer.classic_address, reqs)
    blob = sign_unsigned(built["unsignedTx"], payer)
    decoded = decode(blob)
    assert decoded["SigningPubKey"] == payer.public_key
    resp = client.post("/verify", json=verify_body(payload(blob, reqs), reqs), headers=AUTH)
    assert resp.json() == {"isValid": True, "payer": payer.classic_address}


def test_build_iou_requirements(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    issuer = Wallet.create().classic_address
    reqs = requirements(
        seller.classic_address, amount="1.25", asset="USD", extra={"issuer": issuer}
    )
    built = build_unsigned(client, payer.classic_address, reqs)
    tx = built["unsignedTx"]
    assert tx["Amount"] == {"currency": "USD", "issuer": issuer, "value": "1.25"}
    assert tx["SendMax"] == {"currency": "USD", "issuer": issuer, "value": "1.25"}
    blob = sign_unsigned(tx, payer)
    resp = client.post("/verify", json=verify_body(payload(blob, reqs), reqs), headers=AUTH)
    assert resp.json() == {"isValid": True, "payer": payer.classic_address}


def reject(client: TestClient, body: dict[str, Any], reason: str, status: int = 400) -> None:
    resp = client.post("/payer/build", json=body, headers=AUTH)
    assert resp.status_code == status, resp.text
    assert resp.json() == {"error": reason}


def test_build_rejections(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    account = payer.classic_address
    good = requirements(seller.classic_address)

    no_invoice = requirements(seller.classic_address)
    del no_invoice["extra"]["invoiceId"]
    reject(client, {"account": account, "paymentRequirements": no_invoice}, "missing_invoice_id")

    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, network="xrpl:2"),
        },
        "unsupported_network",
    )
    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, network="xrpl:0"),
        },
        "mainnet_refused",
    )
    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, scheme="upto"),
        },
        "unsupported_scheme",
    )
    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, asset="RLUSD"),
        },
        "unsupported_asset",
    )
    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, asset="USD"),
        },
        "missing_issuer",
    )
    reject(
        client,
        {
            "account": account,
            "paymentRequirements": requirements(seller.classic_address, amount="1.5"),
        },
        "invalid_amount",
    )
    reject(client, {"account": "r" + "x" * 30, "paymentRequirements": good}, "invalid_account")
    reject(
        client,
        {"account": account, "paymentRequirements": good, "maxFeeDrops": 1},
        "fee_exceeds_payer_policy",
    )

    slow = requirements(seller.classic_address)
    slow["maxTimeoutSeconds"] = 121
    reject(client, {"account": account, "paymentRequirements": slow}, "max_timeout_exceeds_policy")

    unfunded = Wallet.create().classic_address
    reject(client, {"account": unfunded, "paymentRequirements": good}, "account_not_found")

    # pydantic-level shape errors are 400 too, never 422/500
    resp = client.post("/payer/build", json={"account": account}, headers=AUTH)
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_request"
