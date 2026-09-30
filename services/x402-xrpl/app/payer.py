"""Build the UNSIGNED presigned-scheme Payment for a buyer (signing happens elsewhere).

Mirrors ``x402_xrpl.client.presigned_payment_payer.XRPLPresignedPaymentPayer.prepare_payment``
field for field (invoice memo + InvoiceID binding "both", optional typed facilitator memo,
SourceTag/DestinationTag from ``extra``, XRP/IOU amount rules, ledger-based expiry,
autofill, RPC network assertion, fee ceiling) but stops before ``sign``.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any

from x402_xrpl.client.presigned_payment_payer import (
    FACILITATOR_MEMO_FORMAT,
    FACILITATOR_MEMO_TYPE,
    invoice_id_to_invoice_id_field,
    invoice_id_to_memo_hex,
    text_to_memo_hex,
)
from x402_xrpl.types import PaymentRequirements
from xrpl.asyncio.clients.async_client import AsyncClient
from xrpl.asyncio.transaction import autofill
from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.models.amounts import IssuedCurrencyAmount
from xrpl.models.transactions import Memo, Payment

from app.facilitator import InvalidPayment, check_requirements
from app.rpc import RpcError, latest_validated_ledger, server_network_id
from app.settings import Settings

LEDGER_CLOSE_SECONDS = 5.0
LEDGER_SAFETY_MARGIN = 2


class PayerBuildError(ValueError):
    """The request cannot be turned into a valid unsigned Payment; ``reason`` is snake_case."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _facilitator_identity(extra: Mapping[str, Any] | None) -> tuple[str, str | None] | None:
    """(id, name) from ``extra.facilitator`` with the SDK's whitelist/trim/cap rules."""
    if not isinstance(extra, Mapping):
        return None
    facilitator = extra.get("facilitator")
    if not isinstance(facilitator, Mapping):
        return None
    raw_id = facilitator.get("id")
    if not isinstance(raw_id, str) or not raw_id.strip():
        return None
    fac_id = raw_id.strip()[:64]
    raw_name = facilitator.get("name")
    fac_name = raw_name.strip()[:128] if isinstance(raw_name, str) and raw_name.strip() else None
    return fac_id, fac_name


def last_ledger_sequence_for(latest_validated: int, max_timeout_seconds: int) -> int:
    """``latest validated + ceil(maxTimeoutSeconds / 5) + 2`` (same formula as the SDK)."""
    delta = int(math.ceil(int(max_timeout_seconds) / LEDGER_CLOSE_SECONDS) + LEDGER_SAFETY_MARGIN)
    return int(latest_validated) + delta


async def build_unsigned_payment(
    *,
    settings: Settings,
    client: AsyncClient,
    account: str,
    requirements_raw: Mapping[str, Any],
    max_fee_drops: int,
) -> dict[str, Any]:
    """Return ``{invoiceId, unsignedTx, lastLedgerSequence, networkId}``; raise PayerBuildError."""
    if not is_valid_classic_address(account):
        raise PayerBuildError("invalid_account")
    if isinstance(max_fee_drops, bool) or not isinstance(max_fee_drops, int) or max_fee_drops < 1:
        raise PayerBuildError("invalid_max_fee_drops")

    try:
        req = PaymentRequirements.from_dict(requirements_raw)
    except Exception as exc:
        raise PayerBuildError("invalid_requirements") from exc
    try:
        asset, tags = check_requirements(req, settings)
    except InvalidPayment as exc:
        raise PayerBuildError(exc.reason) from exc

    invoice_id = req.invoice_id()
    if not invoice_id:
        raise PayerBuildError("missing_invoice_id")
    if req.max_timeout_seconds > settings.max_timeout_seconds:
        raise PayerBuildError("max_timeout_exceeds_policy")

    memos: list[Memo] = [Memo(memo_data=invoice_id_to_memo_hex(invoice_id))]
    identity = _facilitator_identity(req.extra)
    if identity is not None:
        fac_id, fac_name = identity
        facilitator_obj: dict[str, Any] = {"id": fac_id}
        if fac_name:
            facilitator_obj["name"] = fac_name
        if tags.source_tag is not None:
            facilitator_obj["sourceTag"] = tags.source_tag
        memos.append(
            Memo(
                memo_type=text_to_memo_hex(FACILITATOR_MEMO_TYPE),
                memo_data=text_to_memo_hex(json.dumps(facilitator_obj, separators=(",", ":"))),
                memo_format=text_to_memo_hex(FACILITATOR_MEMO_FORMAT),
            )
        )

    amount: str | IssuedCurrencyAmount
    send_max: IssuedCurrencyAmount | None
    if asset.is_xrp:
        amount = str(asset.drops)
        send_max = None
    else:
        assert asset.currency_hex is not None and asset.issuer is not None
        amount = IssuedCurrencyAmount(
            currency=asset.currency_hex, issuer=asset.issuer, value=str(req.amount)
        )
        # IOU policy (same as the SDK): SendMax = same currency+issuer, value == Amount.
        send_max = IssuedCurrencyAmount(
            currency=asset.currency_hex, issuer=asset.issuer, value=str(req.amount)
        )

    try:
        latest = await latest_validated_ledger(client)
    except RpcError as exc:
        raise PayerBuildError("rpc_unavailable") from exc
    last_ledger_sequence = last_ledger_sequence_for(latest, req.max_timeout_seconds)

    try:
        payment = Payment(
            account=account,
            destination=req.pay_to,
            amount=amount,
            send_max=send_max,
            memos=memos,
            invoice_id=invoice_id_to_invoice_id_field(invoice_id),
            source_tag=tags.source_tag,
            destination_tag=tags.destination_tag,
            last_ledger_sequence=last_ledger_sequence,
        )
    except Exception as exc:  # xrpl-py model validation
        raise PayerBuildError("invalid_requirements") from exc

    try:
        filled = await autofill(payment, client)
        network_id, _info = await server_network_id(client)
    except RpcError as exc:
        raise PayerBuildError("rpc_unavailable") from exc
    except Exception as exc:  # xrpl-py wraps rippled errors (e.g. actNotFound) in exceptions
        if "actNotFound" in str(exc):
            raise PayerBuildError("account_not_found") from exc
        raise PayerBuildError("rpc_unavailable") from exc

    if network_id != settings.network_id or (
        filled.network_id is not None and filled.network_id != settings.network_id
    ):
        raise PayerBuildError("rpc_network_mismatch")

    fee = filled.fee
    fee_ceiling = min(max_fee_drops, settings.max_fee_drops)
    if not isinstance(fee, str) or not fee.isascii() or not fee.isdigit():
        raise PayerBuildError("fee_exceeds_payer_policy")
    if not 1 <= int(fee) <= fee_ceiling:
        raise PayerBuildError("fee_exceeds_payer_policy")
    if filled.sequence is None or filled.last_ledger_sequence != last_ledger_sequence:
        raise PayerBuildError("autofill_failed")

    unsigned = filled.to_xrpl()
    # Leave SigningPubKey to the signer (xrpl.js Wallet.sign fills it).
    if unsigned.get("SigningPubKey") == "":
        del unsigned["SigningPubKey"]

    return {
        "invoiceId": invoice_id,
        "unsignedTx": unsigned,
        "lastLedgerSequence": last_ledger_sequence,
        "networkId": settings.network_id,
    }
