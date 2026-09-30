"""x402 facilitator for the XRPL ``exact`` (presigned Payment) scheme.

``LocalFacilitator`` is a real verifier/settler: it decodes the signed blob, checks the
signature and every binding between the transaction and the seller's PaymentRequirements,
then submits the blob and waits for ledger validation. ``RemoteFacilitator`` proxies the
same two calls to a hosted facilitator (X402_FACILITATOR_MODE=remote) after the same
local fail-closed pre-checks.

Every rejection is a short snake_case reason; nothing here raises for bad input.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol, TypeGuard

import httpx
from x402_xrpl.client.presigned_payment_payer import (
    invoice_id_to_invoice_id_field,
    invoice_id_to_memo_hex,
    to_currency_hex,
)
from x402_xrpl.facilitator import AsyncFacilitatorClient, FacilitatorClientOptions
from x402_xrpl.types import PaymentPayload, PaymentRequirements
from xrpl.asyncio.clients.async_client import AsyncClient
from xrpl.core import keypairs
from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.core.binarycodec import decode, encode_for_signing
from xrpl.models.transactions import PaymentFlag

from app.rpc import (
    RpcError,
    TxLookup,
    fetch_account,
    latest_validated_ledger,
    lookup_tx,
    submit_blob,
    tx_hash_from_blob,
)
from app.settings import MAINNET_CAIP2, MAX_UINT32, Settings

log = logging.getLogger("x402.facilitator")

SCHEME = "exact"
X402_VERSION = 2
MAX_XRP_DROPS = 100_000_000_000_000_000  # total supply; anything above is structurally impossible
MAX_INVOICE_ID_LENGTH = 128
SETTLE_GRACE_SECONDS = 30
# Transaction features the exact scheme never uses; their presence means "not what was quoted".
UNSUPPORTED_TX_FIELDS = (
    "Paths",
    "DeliverMin",
    "TicketSequence",
    "Signers",
    "Delegate",
    "Sponsor",
    "AccountTxnID",
)
# Preliminary results after which the hash may still validate (already known to the network).
RETRY_TEF_RESULTS = frozenset({"tefPAST_SEQ", "tefALREADY"})


class InvalidPayment(Exception):
    """A payment failed verification; ``reason`` is the wire ``invalidReason``."""

    def __init__(self, reason: str, payer: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.payer = payer


@dataclass(frozen=True)
class AssetSpec:
    is_xrp: bool
    drops: int | None = None
    currency_hex: str | None = None
    issuer: str | None = None
    value: Decimal | None = None


@dataclass(frozen=True)
class TagSpec:
    source_tag: int | None
    destination_tag: int | None


@dataclass(frozen=True)
class CheckedPayment:
    payload: PaymentPayload
    requirements: PaymentRequirements
    asset: AssetSpec
    tx: dict[str, Any]
    blob: str
    tx_hash: str
    payer: str
    signer_address: str
    sequence: int
    last_ledger_sequence: int
    fee_drops: int
    invoice_id: str


# --------------------------------------------------------------------------- parsing helpers


def _is_uint32(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_UINT32


def _is_drops_string(value: Any) -> TypeGuard[str]:
    return (
        isinstance(value, str)
        and value.isascii()
        and value.isdigit()
        and 1 <= int(value) <= MAX_XRP_DROPS
    )


def _decimal(value: Any) -> Decimal | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _tag(extra: Mapping[str, Any] | None, key: str) -> int | None:
    if not isinstance(extra, Mapping):
        return None
    value = extra.get(key)
    if value is None:
        return None
    if not _is_uint32(value):
        raise InvalidPayment("invalid_requirements")
    return int(value)


def check_requirements(req: PaymentRequirements, settings: Settings) -> tuple[AssetSpec, TagSpec]:
    """Validate a PaymentRequirements against this deployment (scheme, network, asset, tags)."""
    if req.scheme != SCHEME:
        raise InvalidPayment("unsupported_scheme")
    if req.network == MAINNET_CAIP2:
        raise InvalidPayment("mainnet_refused")
    if req.network != settings.caip2:
        raise InvalidPayment("unsupported_network")
    if not isinstance(req.pay_to, str) or not is_valid_classic_address(req.pay_to):
        raise InvalidPayment("invalid_pay_to")
    if isinstance(req.max_timeout_seconds, bool) or req.max_timeout_seconds < 1:
        raise InvalidPayment("invalid_requirements")
    if req.extra is not None and not isinstance(req.extra, Mapping):
        raise InvalidPayment("invalid_requirements")

    tags = TagSpec(
        source_tag=_tag(req.extra, "sourceTag"),
        destination_tag=_tag(req.extra, "destinationTag"),
    )

    asset_code = str(req.asset or "").strip()
    if asset_code.upper() == "XRP":
        if not _is_drops_string(req.amount):
            raise InvalidPayment("invalid_amount")
        return AssetSpec(is_xrp=True, drops=int(req.amount)), tags

    try:
        currency_hex = to_currency_hex(asset_code)
    except ValueError as exc:
        raise InvalidPayment("unsupported_asset") from exc
    issuer = req.extra.get("issuer") if isinstance(req.extra, Mapping) else None
    if not isinstance(issuer, str) or not is_valid_classic_address(issuer):
        raise InvalidPayment("missing_issuer")
    value = _decimal(req.amount)
    if value is None or value <= 0:
        raise InvalidPayment("invalid_amount")
    return AssetSpec(is_xrp=False, currency_hex=currency_hex, issuer=issuer, value=value), tags


def _issuer_of(req: PaymentRequirements) -> str | None:
    issuer = req.extra.get("issuer") if isinstance(req.extra, Mapping) else None
    return issuer if isinstance(issuer, str) else None


def _accepted_matches(accepted: PaymentRequirements, req: PaymentRequirements) -> bool:
    """The buyer's echoed ``accepted`` must be the seller's quote (no substitution)."""
    return (
        accepted.scheme == req.scheme
        and accepted.network == req.network
        and accepted.amount == req.amount
        and str(accepted.asset).strip().upper() == str(req.asset).strip().upper()
        and accepted.pay_to == req.pay_to
        and accepted.invoice_id() == req.invoice_id()
        and _issuer_of(accepted) == _issuer_of(req)
    )


def parse_body(body: Any) -> tuple[PaymentPayload, PaymentRequirements]:
    """Parse ``{paymentPayload, paymentRequirements}`` with the SDK types."""
    if not isinstance(body, Mapping):
        raise InvalidPayment("invalid_request")
    payload_raw = body.get("paymentPayload")
    req_raw = body.get("paymentRequirements")
    if not isinstance(payload_raw, Mapping):
        raise InvalidPayment("invalid_payload")
    if not isinstance(req_raw, Mapping):
        raise InvalidPayment("invalid_requirements")
    try:
        payload = PaymentPayload.from_dict(payload_raw)
    except Exception as exc:
        raise InvalidPayment("invalid_payload") from exc
    try:
        req = PaymentRequirements.from_dict(req_raw)
    except Exception as exc:
        raise InvalidPayment("invalid_requirements") from exc
    if payload.x402_version != X402_VERSION:
        raise InvalidPayment("unsupported_x402_version")
    return payload, req


def _inner_payload(payload: PaymentPayload) -> tuple[str, str]:
    inner = payload.payload
    if not isinstance(inner, Mapping):
        raise InvalidPayment("invalid_payload")
    blob = inner.get("signedTxBlob")
    invoice_id = inner.get("invoiceId")
    if not isinstance(blob, str) or not blob or len(blob) % 2:
        raise InvalidPayment("invalid_payload")
    try:
        bytes.fromhex(blob)
    except ValueError as exc:
        raise InvalidPayment("invalid_payload") from exc
    if not isinstance(invoice_id, str) or not invoice_id or len(invoice_id) > MAX_INVOICE_ID_LENGTH:
        raise InvalidPayment("invalid_payload")
    return blob.upper(), invoice_id


def _invoice_bound(tx: Mapping[str, Any], invoice_id: str) -> bool:
    memo_hex = invoice_id_to_memo_hex(invoice_id)
    memos = tx.get("Memos")
    if isinstance(memos, list):
        for entry in memos:
            inner = entry.get("Memo") if isinstance(entry, Mapping) else None
            data = inner.get("MemoData") if isinstance(inner, Mapping) else None
            if isinstance(data, str) and data.upper() == memo_hex:
                return True
    invoice_field = tx.get("InvoiceID")
    return isinstance(invoice_field, str) and (
        invoice_field.upper() == invoice_id_to_invoice_id_field(invoice_id)
    )


def _check_amount(tx: Mapping[str, Any], asset: AssetSpec, payer: str) -> None:
    amount = tx.get("Amount")
    if asset.is_xrp:
        if not isinstance(amount, str):
            raise InvalidPayment("asset_mismatch", payer)
        if not _is_drops_string(amount) or int(amount) != asset.drops:
            raise InvalidPayment("amount_mismatch", payer)
        if "SendMax" in tx:
            raise InvalidPayment("unsupported_payment_features", payer)
        return

    if not isinstance(amount, Mapping):
        raise InvalidPayment("asset_mismatch", payer)
    try:
        currency_hex = to_currency_hex(str(amount.get("currency", "")))
    except ValueError as exc:
        raise InvalidPayment("asset_mismatch", payer) from exc
    if currency_hex != asset.currency_hex or amount.get("issuer") != asset.issuer:
        raise InvalidPayment("asset_mismatch", payer)
    value = _decimal(amount.get("value"))
    if value is None or value != asset.value:
        raise InvalidPayment("amount_mismatch", payer)
    send_max = tx.get("SendMax")
    if send_max is not None:
        if not isinstance(send_max, Mapping):
            raise InvalidPayment("unsupported_payment_features", payer)
        try:
            send_currency = to_currency_hex(str(send_max.get("currency", "")))
        except ValueError as exc:
            raise InvalidPayment("unsupported_payment_features", payer) from exc
        send_value = _decimal(send_max.get("value"))
        if (
            send_currency != asset.currency_hex
            or send_max.get("issuer") != asset.issuer
            or send_value is None
            or send_value < asset.value
        ):
            raise InvalidPayment("unsupported_payment_features", payer)


# --------------------------------------------------------------------------- verification


def check_payment_offline(body: Any, settings: Settings) -> CheckedPayment:
    """Every check that needs no ledger state: structure, bindings, signature, expiry fields."""
    payload, req = parse_body(body)
    asset, tags = check_requirements(req, settings)
    if not _accepted_matches(payload.accepted, req):
        raise InvalidPayment("requirements_mismatch")

    blob, invoice_id = _inner_payload(payload)
    quoted_invoice = req.invoice_id()
    if quoted_invoice is not None and quoted_invoice != invoice_id:
        raise InvalidPayment("invoice_mismatch")

    try:
        tx = decode(blob)
    except Exception as exc:
        raise InvalidPayment("invalid_tx_blob") from exc
    if not isinstance(tx, dict) or tx.get("TransactionType") != "Payment":
        raise InvalidPayment("invalid_transaction_type")
    if "Signers" in tx:
        raise InvalidPayment("multisign_unsupported")
    for field in UNSUPPORTED_TX_FIELDS:
        if field in tx:
            raise InvalidPayment("unsupported_payment_features")

    pub_key = tx.get("SigningPubKey")
    signature = tx.get("TxnSignature")
    if (
        not isinstance(pub_key, str)
        or not pub_key
        or not isinstance(signature, str)
        or not signature
    ):
        raise InvalidPayment("invalid_signature")
    try:
        signing_bytes = bytes.fromhex(encode_for_signing(tx))
        valid = keypairs.is_valid_message(signing_bytes, bytes.fromhex(signature), pub_key)
        signer_address = keypairs.derive_classic_address(pub_key)
    except Exception as exc:
        raise InvalidPayment("invalid_signature") from exc
    if not valid:
        raise InvalidPayment("invalid_signature")

    payer = tx.get("Account")
    if not isinstance(payer, str) or not is_valid_classic_address(payer):
        raise InvalidPayment("invalid_payer")

    if tx.get("Destination") != req.pay_to:
        raise InvalidPayment("destination_mismatch", payer)
    flags = tx.get("Flags", 0)
    if isinstance(flags, int) and flags & PaymentFlag.TF_PARTIAL_PAYMENT:
        raise InvalidPayment("partial_payment_not_allowed", payer)
    _check_amount(tx, asset, payer)

    if not _invoice_bound(tx, invoice_id):
        raise InvalidPayment("invoice_binding_missing", payer)

    if tags.source_tag is not None and tx.get("SourceTag") != tags.source_tag:
        raise InvalidPayment("source_tag_mismatch", payer)
    if tags.destination_tag is not None:
        if tx.get("DestinationTag") != tags.destination_tag:
            raise InvalidPayment("destination_tag_mismatch", payer)
    elif "DestinationTag" in tx:
        raise InvalidPayment("destination_tag_mismatch", payer)

    fee = tx.get("Fee")
    if not _is_drops_string(fee) or int(str(fee)) > settings.max_fee_drops:
        raise InvalidPayment("invalid_fee", payer)
    last_ledger_sequence = tx.get("LastLedgerSequence")
    if not _is_uint32(last_ledger_sequence) or last_ledger_sequence < 1:
        raise InvalidPayment("missing_last_ledger_sequence", payer)
    sequence = tx.get("Sequence")
    if not _is_uint32(sequence) or sequence < 1:
        raise InvalidPayment("missing_sequence", payer)
    network_id = tx.get("NetworkID")
    if network_id is not None and network_id != settings.network_id:
        raise InvalidPayment("network_mismatch", payer)

    return CheckedPayment(
        payload=payload,
        requirements=req,
        asset=asset,
        tx=tx,
        blob=blob,
        tx_hash=tx_hash_from_blob(blob),
        payer=payer,
        signer_address=signer_address,
        sequence=int(sequence),
        last_ledger_sequence=int(last_ledger_sequence),
        fee_drops=int(str(fee)),
        invoice_id=invoice_id,
    )


async def check_payment_online(checked: CheckedPayment, client: AsyncClient) -> None:
    """Ledger-state checks: unexpired, payer exists, sequence unused, signer authorized, funded."""
    payer = checked.payer
    try:
        latest = await latest_validated_ledger(client)
        if checked.last_ledger_sequence <= latest:
            raise InvalidPayment("expired", payer)
        account = await fetch_account(client, payer)
    except RpcError as exc:
        log.warning("rpc_unavailable during verify", extra={"error": str(exc), "payer": payer})
        raise InvalidPayment("rpc_unavailable", payer) from exc

    if account is None:
        raise InvalidPayment("account_not_found", payer)
    if account.sequence > checked.sequence:
        raise InvalidPayment("sequence_already_used", payer)
    if checked.signer_address not in (payer, account.regular_key):
        raise InvalidPayment("signer_not_authorized", payer)
    needed = checked.fee_drops + (checked.asset.drops or 0)
    if account.balance_drops < needed:
        raise InvalidPayment("insufficient_funds", payer)


# --------------------------------------------------------------------------- facilitators


class Facilitator(Protocol):
    mode: str

    async def verify(self, body: Any) -> dict[str, Any]: ...

    async def settle(self, body: Any) -> dict[str, Any]: ...

    async def aclose(self) -> None: ...


def _invalid(exc: InvalidPayment) -> dict[str, Any]:
    out: dict[str, Any] = {"isValid": False, "invalidReason": exc.reason}
    if exc.payer:
        out["payer"] = exc.payer
    return out


class LocalFacilitator:
    """Embedded verifier + settler (X402_FACILITATOR_MODE=local)."""

    mode = "local"

    def __init__(self, settings: Settings, client: AsyncClient) -> None:
        self._settings = settings
        self._client = client

    async def aclose(self) -> None:
        return None

    async def verify(self, body: Any) -> dict[str, Any]:
        try:
            checked = check_payment_offline(body, self._settings)
            await check_payment_online(checked, self._client)
        except InvalidPayment as exc:
            log.info("verify rejected", extra={"reason": exc.reason, "payer": exc.payer})
            return _invalid(exc)
        log.info("verify ok", extra={"payer": checked.payer, "txHash": checked.tx_hash})
        return {"isValid": True, "payer": checked.payer}

    def _failure(
        self,
        reason: str,
        payer: str | None = None,
        extensions: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "success": False,
            "errorReason": reason,
            "transaction": "",
            "network": self._settings.caip2,
        }
        if payer:
            out["payer"] = payer
        if extensions:
            out["extensions"] = dict(extensions)
        log.info("settle failed", extra={"reason": reason, "payer": payer, **(extensions or {})})
        return out

    def _final(self, checked: CheckedPayment, found: TxLookup) -> dict[str, Any]:
        if found.result == "tesSUCCESS":
            log.info(
                "settle ok",
                extra={
                    "txHash": checked.tx_hash,
                    "ledgerIndex": found.ledger_index,
                    "payer": checked.payer,
                },
            )
            return {
                "success": True,
                "transaction": checked.tx_hash,
                "network": self._settings.caip2,
                "payer": checked.payer,
                "extensions": {
                    "ledgerIndex": found.ledger_index,
                    "deliveredAmount": found.delivered_amount,
                    "closeTime": found.close_time,
                },
            }
        return self._failure(
            found.result or "unknown_result",
            checked.payer,
            {"transactionHash": checked.tx_hash, "ledgerIndex": found.ledger_index},
        )

    async def settle(self, body: Any) -> dict[str, Any]:
        try:
            checked = check_payment_offline(body, self._settings)
        except InvalidPayment as exc:
            return self._failure(exc.reason, exc.payer)

        # Idempotency: the hash is a pure function of the blob; if the ledger already
        # validated it we return the same settlement instead of resubmitting.
        try:
            existing = await lookup_tx(self._client, checked.tx_hash)
        except RpcError as exc:
            log.warning("rpc_unavailable during settle lookup", extra={"error": str(exc)})
            return self._failure("rpc_unavailable", checked.payer)
        if existing is not None and existing.validated:
            return self._final(checked, existing)

        preliminary = "pending"
        if existing is None:
            try:
                await check_payment_online(checked, self._client)
            except InvalidPayment as exc:
                return self._failure(exc.reason, exc.payer)
            try:
                outcome = await submit_blob(self._client, checked.blob)
            except RpcError as exc:
                # The request may or may not have reached the network: report unknown,
                # never "failed", and hand back the hash so the caller can look it up.
                log.warning("rpc error during submit", extra={"error": str(exc)})
                return self._failure(
                    "settlement_status_unknown",
                    checked.payer,
                    {"transactionHash": checked.tx_hash},
                )
            preliminary = outcome.engine_result or "unknown"
            log.info(
                "submitted",
                extra={"txHash": checked.tx_hash, "engineResult": preliminary},
            )
            if preliminary.startswith("tem") or (
                preliminary.startswith("tef") and preliminary not in RETRY_TEF_RESULTS
            ):
                return self._failure(preliminary, checked.payer)

        return await self._await_validation(checked, preliminary)

    async def _await_validation(self, checked: CheckedPayment, preliminary: str) -> dict[str, Any]:
        timeout = min(checked.requirements.max_timeout_seconds, self._settings.max_timeout_seconds)
        deadline = time.monotonic() + timeout + SETTLE_GRACE_SECONDS
        extensions = {"transactionHash": checked.tx_hash, "preliminaryResult": preliminary}
        while True:
            try:
                # Fetch the ledger index BEFORE the lookup so a tx included in exactly
                # LastLedgerSequence is never reported as expired.
                latest = await latest_validated_ledger(self._client)
                found = await lookup_tx(self._client, checked.tx_hash)
            except RpcError as exc:
                log.warning("rpc error while polling", extra={"error": str(exc)})
                if time.monotonic() >= deadline:
                    return self._failure("settlement_status_unknown", checked.payer, extensions)
                await asyncio.sleep(self._settings.settle_poll_seconds)
                continue
            if found is not None and found.validated:
                return self._final(checked, found)
            if latest >= checked.last_ledger_sequence:
                return self._failure("expired_before_validation", checked.payer, extensions)
            if time.monotonic() >= deadline:
                return self._failure("settlement_timeout", checked.payer, extensions)
            await asyncio.sleep(self._settings.settle_poll_seconds)


def payment_header(payload: PaymentPayload) -> str:
    """base64(JSON) envelope, exactly as the SDK builds PAYMENT-SIGNATURE."""
    raw = json.dumps(payload.to_dict(), separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.b64encode(raw).decode("utf-8")


class RemoteFacilitator:
    """Proxy verify/settle to a hosted facilitator after the same local pre-checks."""

    mode = "remote"

    def __init__(self, settings: Settings) -> None:
        if not settings.facilitator_url:
            raise ValueError("facilitator_url is required in remote mode")
        self._settings = settings
        self._client = AsyncFacilitatorClient(
            FacilitatorClientOptions(
                base_url=settings.facilitator_url,
                timeout_seconds=float(settings.max_timeout_seconds + SETTLE_GRACE_SECONDS),
            )
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def verify(self, body: Any) -> dict[str, Any]:
        try:
            checked = check_payment_offline(body, self._settings)
        except InvalidPayment as exc:
            return _invalid(exc)
        try:
            resp = await self._client.verify(
                payment_header=payment_header(checked.payload),
                payment_requirements=checked.requirements,
            )
        except httpx.HTTPStatusError as exc:
            return {
                "isValid": False,
                "invalidReason": f"facilitator_http_error_{exc.response.status_code}",
            }
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("remote verify failed", extra={"error": str(exc)})
            return {"isValid": False, "invalidReason": "facilitator_unavailable"}
        out: dict[str, Any] = {"isValid": resp.is_valid}
        if resp.invalid_reason is not None:
            out["invalidReason"] = resp.invalid_reason
        if resp.payer is not None:
            out["payer"] = resp.payer
        if resp.extensions:
            out["extensions"] = dict(resp.extensions)
        return out

    async def settle(self, body: Any) -> dict[str, Any]:
        try:
            checked = check_payment_offline(body, self._settings)
        except InvalidPayment as exc:
            out: dict[str, Any] = {
                "success": False,
                "errorReason": exc.reason,
                "transaction": "",
                "network": self._settings.caip2,
            }
            if exc.payer:
                out["payer"] = exc.payer
            return out
        try:
            resp = await self._client.settle(
                payment_header=payment_header(checked.payload),
                payment_requirements=checked.requirements,
            )
        except httpx.ConnectError:
            reason = "facilitator_unavailable"
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("remote settle failed", extra={"error": str(exc)})
            reason = "settlement_status_unknown"
        else:
            result = resp.to_dict()
            result.setdefault("network", self._settings.caip2)
            return result
        return {
            "success": False,
            "errorReason": reason,
            "transaction": "",
            "network": self._settings.caip2,
            "payer": checked.payer,
            "extensions": {"transactionHash": checked.tx_hash},
        }
