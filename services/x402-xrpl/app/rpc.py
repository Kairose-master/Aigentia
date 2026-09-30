"""Thin, typed helpers over the xrpl-py async client (the only place rippled is spoken to)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from xrpl.asyncio.clients.async_client import AsyncClient
from xrpl.asyncio.ledger import get_latest_validated_ledger_sequence
from xrpl.models.requests import AccountInfo, ServerInfo, SubmitOnly, Tx
from xrpl.models.requests.request import Request
from xrpl.models.response import Response
from xrpl.utils import ripple_time_to_datetime

# rippled hashes a signed transaction as SHA-512-half(b"TXN\x00" + serialized tx).
TX_HASH_PREFIX = "54584E00"


class RpcError(RuntimeError):
    """Transport or protocol failure while talking to rippled (not a payment verdict)."""


def tx_hash_from_blob(blob: str) -> str:
    """Transaction hash of a signed tx blob (uppercase hex), exactly as the ledger computes it."""
    digest = hashlib.sha512(bytes.fromhex(TX_HASH_PREFIX + blob)).digest()
    return digest[:32].hex().upper()


async def _request(client: AsyncClient, request: Request) -> Response:
    try:
        return await client.request(request)
    except Exception as exc:  # httpx / xrpl-py transport and decoding failures
        raise RpcError(f"{type(exc).__name__}: {exc}") from exc


async def server_network_id(client: AsyncClient) -> tuple[int | None, dict[str, Any]]:
    """Return ``(info.network_id, info)`` from ``server_info``."""
    response = await _request(client, ServerInfo())
    if not response.is_successful():
        raise RpcError(f"server_info failed: {response.result.get('error')}")
    info = response.result.get("info")
    if not isinstance(info, dict):
        raise RpcError("server_info: missing info object")
    network_id = info.get("network_id")
    if isinstance(network_id, bool) or not isinstance(network_id, int):
        return None, info
    return network_id, info


async def latest_validated_ledger(client: AsyncClient) -> int:
    try:
        return await get_latest_validated_ledger_sequence(client)
    except Exception as exc:
        raise RpcError(f"ledger(validated) failed: {exc}") from exc


@dataclass(frozen=True)
class AccountState:
    address: str
    balance_drops: int
    sequence: int
    regular_key: str | None
    flags: int


async def fetch_account(client: AsyncClient, address: str) -> AccountState | None:
    """``account_info`` on the validated ledger; ``None`` when the account does not exist."""
    response = await _request(client, AccountInfo(account=address, ledger_index="validated"))
    if not response.is_successful():
        if response.result.get("error") == "actNotFound":
            return None
        raise RpcError(f"account_info failed: {response.result.get('error')}")
    data = response.result.get("account_data")
    if not isinstance(data, dict):
        raise RpcError("account_info: missing account_data")
    try:
        balance = int(str(data.get("Balance", "0")))
        sequence = int(data.get("Sequence", 0))
        flags = int(data.get("Flags", 0))
    except (TypeError, ValueError) as exc:
        raise RpcError("account_info: malformed account_data") from exc
    regular_key = data.get("RegularKey")
    return AccountState(
        address=address,
        balance_drops=balance,
        sequence=sequence,
        regular_key=regular_key if isinstance(regular_key, str) else None,
        flags=flags,
    )


@dataclass(frozen=True)
class TxLookup:
    tx_hash: str
    validated: bool
    result: str | None
    ledger_index: int | None
    delivered_amount: Any
    account: str | None
    destination: str | None
    close_time: str | None
    last_ledger_sequence: int | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "found": True,
            "validated": self.validated,
            "result": self.result,
            "ledgerIndex": self.ledger_index,
            "deliveredAmount": self.delivered_amount,
            "account": self.account,
            "destination": self.destination,
            "closeTime": self.close_time,
        }


def _opt_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def parse_tx_result(result: dict[str, Any], requested_hash: str) -> TxLookup:
    """Normalize a ``tx`` result (rippled API v1 flattened or v2 ``tx_json`` layouts)."""
    tx_json_raw = result.get("tx_json")
    tx_json: dict[str, Any] = tx_json_raw if isinstance(tx_json_raw, dict) else result
    meta_raw = result.get("meta")
    meta: dict[str, Any] = meta_raw if isinstance(meta_raw, dict) else {}
    validated = result.get("validated") is True

    close_time = _opt_str(result.get("close_time_iso"))
    if close_time is None:
        ripple_date = _opt_int(result.get("date")) or _opt_int(tx_json.get("date"))
        if ripple_date is not None:
            close_time = ripple_time_to_datetime(ripple_date).isoformat().replace("+00:00", "Z")

    return TxLookup(
        tx_hash=(_opt_str(result.get("hash")) or _opt_str(tx_json.get("hash")) or requested_hash),
        validated=validated,
        result=_opt_str(meta.get("TransactionResult")) if validated else None,
        ledger_index=_opt_int(result.get("ledger_index")) if validated else None,
        delivered_amount=meta.get("delivered_amount") if validated else None,
        account=_opt_str(tx_json.get("Account")),
        destination=_opt_str(tx_json.get("Destination")),
        close_time=close_time if validated else None,
        last_ledger_sequence=_opt_int(tx_json.get("LastLedgerSequence")),
    )


async def lookup_tx(client: AsyncClient, tx_hash: str) -> TxLookup | None:
    """Look a transaction up by hash; ``None`` when rippled does not know it."""
    response = await _request(client, Tx(transaction=tx_hash))
    if not response.is_successful():
        if response.result.get("error") == "txnNotFound":
            return None
        raise RpcError(f"tx failed: {response.result.get('error')}")
    return parse_tx_result(response.result, tx_hash)


@dataclass(frozen=True)
class SubmitOutcome:
    engine_result: str
    engine_result_message: str
    tx_hash: str | None


async def submit_blob(client: AsyncClient, blob: str) -> SubmitOutcome:
    """Submit an already-signed blob (``submit`` + ``tx_blob``); returns the preliminary result."""
    response = await _request(client, SubmitOnly(tx_blob=blob))
    if not response.is_successful():
        raise RpcError(f"submit failed: {response.result.get('error')}")
    result = response.result
    tx_json = result.get("tx_json")
    tx_hash = tx_json.get("hash") if isinstance(tx_json, dict) else None
    return SubmitOutcome(
        engine_result=str(result.get("engine_result") or ""),
        engine_result_message=str(result.get("engine_result_message") or ""),
        tx_hash=tx_hash if isinstance(tx_hash, str) else None,
    )
