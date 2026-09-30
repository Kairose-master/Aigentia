from __future__ import annotations

import copy
from typing import Any

from fastapi.testclient import TestClient
from x402_xrpl.client.presigned_payment_payer import (
    invoice_id_to_invoice_id_field,
    invoice_id_to_memo_hex,
)
from xrpl.core.binarycodec import decode, encode
from xrpl.models.transactions import Memo, Payment, PaymentFlag
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from tests.conftest import (
    AUTH,
    SOURCE_TAG,
    FakeRpcClient,
    build_sign,
    payload,
    requirements,
    verify_body,
)


def verify(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    resp = client.post("/verify", json=body, headers=AUTH)
    assert resp.status_code == 200, resp.text
    out: dict[str, Any] = resp.json()
    return out


def manual_payment(
    payer: Wallet,
    destination: str,
    *,
    invoice_id: str | None,
    ledger: int,
    amount: str = "1000",
    fee: str = "10",
    flags: int = 0,
    source_tag: int | None = SOURCE_TAG,
    sequence: int = 1,
) -> str:
    """A hand-built signed Payment (to exercise blobs the builder would never produce)."""
    tx = Payment(
        account=payer.classic_address,
        destination=destination,
        amount=amount,
        fee=fee,
        sequence=sequence,
        last_ledger_sequence=ledger + 30,
        source_tag=source_tag,
        flags=flags,
        memos=[Memo(memo_data=invoice_id_to_memo_hex(invoice_id))] if invoice_id else None,
        invoice_id=invoice_id_to_invoice_id_field(invoice_id) if invoice_id else None,
    )
    return sign(tx, payer).blob()


def test_build_sign_verify_ok(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    blob, unsigned = build_sign(client, payer, reqs)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out == {"isValid": True, "payer": payer.classic_address}

    decoded = decode(blob)
    assert decoded["InvoiceID"] == invoice_id_to_invoice_id_field("inv-0001")
    assert decoded["Memos"][0]["Memo"]["MemoData"] == invoice_id_to_memo_hex("inv-0001")
    assert decoded["SourceTag"] == SOURCE_TAG
    assert unsigned["LastLedgerSequence"] == decoded["LastLedgerSequence"]


def test_tampered_amount_is_invalid_signature(
    client: TestClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    tampered = decode(blob)
    tampered["Amount"] = "1"
    out = verify(client, verify_body(payload(encode(tampered), reqs), reqs))
    assert out["isValid"] is False
    assert out["invalidReason"] == "invalid_signature"


def test_bad_signature(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    broken = decode(blob)
    sig = broken["TxnSignature"]
    last = "0" if sig[-1] != "0" else "1"
    broken["TxnSignature"] = sig[:-1] + last
    out = verify(client, verify_body(payload(encode(broken), reqs), reqs))
    assert out == {"isValid": False, "invalidReason": "invalid_signature"}


def test_amount_mismatch(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    cheaper = requirements(seller.classic_address, amount="999")
    blob, _ = build_sign(client, payer, cheaper)
    quoted = requirements(seller.classic_address, amount="1000")
    out = verify(client, verify_body(payload(blob, quoted), quoted))
    assert out["invalidReason"] == "amount_mismatch"
    assert out["payer"] == payer.classic_address


def test_wrong_destination(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    other = Wallet.create()
    blob, _ = build_sign(client, payer, requirements(other.classic_address))
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "destination_mismatch"


def test_missing_invoice_binding(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    blob = manual_payment(
        payer, seller.classic_address, invoice_id=None, ledger=rpc.validated_ledger
    )
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "invoice_binding_missing"


def test_invoice_id_mismatch_between_payload_and_quote(
    client: TestClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    out = verify(client, verify_body(payload(blob, reqs, invoice_id="inv-other"), reqs))
    assert out["invalidReason"] == "invoice_mismatch"


def test_wrong_source_tag(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    blob, _ = build_sign(client, payer, requirements(seller.classic_address, source_tag=7))
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "source_tag_mismatch"


def test_destination_tag_rules(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    tagged = requirements(seller.classic_address, extra={"destinationTag": 42})
    blob, _ = build_sign(client, payer, tagged)
    assert decode(blob)["DestinationTag"] == 42
    assert verify(client, verify_body(payload(blob, tagged), tagged))["isValid"] is True

    untagged = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, untagged), untagged))
    assert out["invalidReason"] == "destination_tag_mismatch"


def test_expired_last_ledger_sequence(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, unsigned = build_sign(client, payer, reqs)
    rpc.advance(unsigned["LastLedgerSequence"] - rpc.validated_ledger)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "expired"


def test_requirements_mismatch(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    accepted = copy.deepcopy(reqs)
    accepted["amount"] = "1"
    out = verify(client, verify_body(payload(blob, accepted), reqs))
    assert out == {"isValid": False, "invalidReason": "requirements_mismatch"}


def test_wrong_network(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    devnet = requirements(seller.classic_address, network="xrpl:2")
    assert verify(client, verify_body(payload(blob, devnet), devnet)) == {
        "isValid": False,
        "invalidReason": "unsupported_network",
    }
    mainnet = requirements(seller.classic_address, network="xrpl:0")
    assert verify(client, verify_body(payload(blob, mainnet), mainnet)) == {
        "isValid": False,
        "invalidReason": "mainnet_refused",
    }


def test_wrong_scheme_and_version(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    upto = requirements(seller.classic_address, scheme="upto")
    assert (
        verify(client, verify_body(payload(blob, upto), upto))["invalidReason"]
        == "unsupported_scheme"
    )
    v1 = payload(blob, reqs)
    v1["x402Version"] = 1
    assert verify(client, verify_body(v1, reqs))["invalidReason"] == "unsupported_x402_version"


def test_partial_payment_flag_rejected(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    blob = manual_payment(
        payer,
        seller.classic_address,
        invoice_id="inv-0001",
        ledger=rpc.validated_ledger,
        flags=int(PaymentFlag.TF_PARTIAL_PAYMENT),
    )
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "partial_payment_not_allowed"


def test_fee_above_ceiling(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    blob = manual_payment(
        payer,
        seller.classic_address,
        invoice_id="inv-0001",
        ledger=rpc.validated_ledger,
        fee="100001",
    )
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "invalid_fee"


def test_insufficient_funds_and_unknown_account(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    rpc.accounts[payer.classic_address]["Balance"] = "1009"  # 1000 + fee 10 needed
    assert (
        verify(client, verify_body(payload(blob, reqs), reqs))["invalidReason"]
        == "insufficient_funds"
    )

    del rpc.accounts[payer.classic_address]
    assert (
        verify(client, verify_body(payload(blob, reqs), reqs))["invalidReason"]
        == "account_not_found"
    )


def test_sequence_already_used(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    reqs = requirements(seller.classic_address)
    blob, _ = build_sign(client, payer, reqs)
    rpc.accounts[payer.classic_address]["Sequence"] = 5
    assert (
        verify(client, verify_body(payload(blob, reqs), reqs))["invalidReason"]
        == "sequence_already_used"
    )


def test_signer_must_be_account_or_regular_key(
    client: TestClient, rpc: FakeRpcClient, payer: Wallet, seller: Wallet
) -> None:
    impostor = Wallet.create()
    reqs = requirements(seller.classic_address)
    # Signed by `impostor`'s key but claiming `payer` as Account.
    tx = Payment(
        account=payer.classic_address,
        destination=seller.classic_address,
        amount="1000",
        fee="10",
        sequence=1,
        last_ledger_sequence=rpc.validated_ledger + 30,
        source_tag=SOURCE_TAG,
        memos=[Memo(memo_data=invoice_id_to_memo_hex("inv-0001"))],
    )
    signed = sign(tx, impostor)
    forged = decode(signed.blob())
    forged["Account"] = payer.classic_address
    blob = encode(forged)
    out = verify(client, verify_body(payload(blob, reqs), reqs))
    assert out["invalidReason"] == "signer_not_authorized"

    rpc.fund(payer.classic_address, regular_key=impostor.classic_address)
    assert verify(client, verify_body(payload(blob, reqs), reqs))["isValid"] is True


def test_garbage_blob_and_non_payment(client: TestClient, payer: Wallet, seller: Wallet) -> None:
    reqs = requirements(seller.classic_address)
    out = verify(client, verify_body(payload("ZZZZ", reqs), reqs))
    assert out["invalidReason"] == "invalid_payload"
    out = verify(client, verify_body(payload("00", reqs), reqs))
    assert out["invalidReason"] == "invalid_tx_blob"
