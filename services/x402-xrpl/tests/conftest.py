"""Test fixtures: an in-memory fake rippled and an app wired to it (no network)."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from xrpl.asyncio.clients.async_client import AsyncClient
from xrpl.core.binarycodec import decode
from xrpl.models.requests.request import Request
from xrpl.models.response import Response, ResponseStatus, ResponseType
from xrpl.models.transactions import Payment
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from app.main import create_app
from app.rpc import tx_hash_from_blob
from app.settings import Settings

TOKEN = "test-internal-token"
AUTH = {"X-Internal-Token": TOKEN}
SOURCE_TAG = 804681468
START_LEDGER = 1_000_000


class FakeRpcClient(AsyncClient):
    """Implements the rippled subset the service uses: server_info, ledger, fee,
    account_info, tx and submit, with an in-memory validated-ledger counter."""

    def __init__(self, *, network_id: int = 1, validated_ledger: int = START_LEDGER) -> None:
        super().__init__("http://fake-rippled.invalid/")
        self.reported_network_id = network_id
        self.validated_ledger = validated_ledger
        self.fee_drops = "10"
        self.accounts: dict[str, dict[str, Any]] = {}
        self.txs: dict[str, dict[str, Any]] = {}
        self.submissions: list[str] = []
        self.submit_engine_result = "tesSUCCESS"
        self.validate_on_submit = True
        self.advance_per_ledger_query = 0
        self.calls: list[str] = []

    # -- test controls -------------------------------------------------------------
    def fund(
        self,
        address: str,
        drops: int = 100_000_000,
        *,
        sequence: int = 1,
        regular_key: str | None = None,
    ) -> None:
        data: dict[str, Any] = {
            "Account": address,
            "Balance": str(drops),
            "Sequence": sequence,
            "Flags": 0,
        }
        if regular_key:
            data["RegularKey"] = regular_key
        self.accounts[address] = data

    def advance(self, ledgers: int = 1) -> None:
        self.validated_ledger += ledgers

    # -- rippled emulation --------------------------------------------------------
    @staticmethod
    def _ok(result: dict[str, Any]) -> Response:
        return Response(status=ResponseStatus.SUCCESS, result=result, type=ResponseType.RESPONSE)

    @staticmethod
    def _err(error: str) -> Response:
        return Response(
            status=ResponseStatus.ERROR,
            result={"error": error, "error_message": error},
            type=ResponseType.RESPONSE,
        )

    async def _request_impl(self, request: Request, *, timeout: float = 10.0) -> Response:
        params = request.to_dict()
        method = str(params["method"])
        self.calls.append(method)
        if method == "server_info":
            return self._ok(
                {
                    "info": {
                        "network_id": self.reported_network_id,
                        "build_version": "2.4.0",
                        "validated_ledger": {"seq": self.validated_ledger},
                    }
                }
            )
        if method == "ledger":
            self.validated_ledger += self.advance_per_ledger_query
            return self._ok(
                {
                    "ledger_index": self.validated_ledger,
                    "ledger": {"ledger_index": self.validated_ledger, "closed": True},
                    "validated": True,
                }
            )
        if method == "fee":
            f = self.fee_drops
            return self._ok(
                {
                    "drops": {
                        "base_fee": f,
                        "open_ledger_fee": f,
                        "minimum_fee": f,
                        "median_fee": f,
                    },
                    "ledger_current_index": self.validated_ledger + 1,
                }
            )
        if method == "account_info":
            account = self.accounts.get(str(params["account"]))
            if account is None:
                return self._err("actNotFound")
            return self._ok(
                {
                    "account_data": dict(account),
                    "ledger_index": self.validated_ledger,
                    "validated": True,
                }
            )
        if method == "tx":
            record = self.txs.get(str(params["transaction"]).upper())
            if record is None:
                return self._err("txnNotFound")
            result: dict[str, Any] = {
                "hash": record["hash"],
                "tx_json": dict(record["tx"]),
                "validated": record["validated"],
            }
            if record["validated"]:
                result["ledger_index"] = record["ledger_index"]
                result["close_time_iso"] = "2026-09-30T12:00:00Z"
                result["meta"] = {
                    "TransactionResult": record["result"],
                    "delivered_amount": record["tx"].get("Amount"),
                }
            return self._ok(result)
        if method == "submit":
            return self._submit(str(params["tx_blob"]))
        raise AssertionError(f"FakeRpcClient: unexpected method {method}")

    def _submit(self, blob: str) -> Response:
        self.submissions.append(blob)
        tx = decode(blob)
        tx_hash = tx_hash_from_blob(blob)
        known = self.txs.get(tx_hash)
        if known is not None and known["validated"]:
            engine = "tefALREADY"
        else:
            account = self.accounts.get(str(tx["Account"]))
            if account is None:
                engine = "terNO_ACCOUNT"
            elif tx["Sequence"] < account["Sequence"]:
                engine = "tefPAST_SEQ"
            elif tx["Sequence"] > account["Sequence"]:
                engine = "terPRE_SEQ"
            elif tx["LastLedgerSequence"] <= self.validated_ledger:
                engine = "tefMAX_LEDGER"
            else:
                engine = self.submit_engine_result
        applies = engine.startswith(("tes", "tec"))
        if applies:
            self.txs[tx_hash] = {
                "hash": tx_hash,
                "tx": {**tx, "hash": tx_hash},
                "result": engine,
                "validated": False,
                "ledger_index": None,
            }
            if self.validate_on_submit:
                self.validate_pending()
        return self._ok(
            {
                "engine_result": engine,
                "engine_result_message": engine,
                "accepted": applies,
                "applied": applies,
                "tx_json": {**tx, "hash": tx_hash},
            }
        )

    def validate_pending(self) -> None:
        """Close one ledger containing every pending transaction."""
        self.validated_ledger += 1
        for record in self.txs.values():
            if record["validated"]:
                continue
            record["validated"] = True
            record["ledger_index"] = self.validated_ledger
            tx = record["tx"]
            account = self.accounts[tx["Account"]]
            account["Sequence"] += 1
            balance = int(account["Balance"]) - int(tx["Fee"])
            if record["result"] == "tesSUCCESS" and isinstance(tx.get("Amount"), str):
                balance -= int(tx["Amount"])
                dest = self.accounts.get(tx["Destination"])
                if dest is not None:
                    dest["Balance"] = str(int(dest["Balance"]) + int(tx["Amount"]))
            account["Balance"] = str(balance)


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "service_token": TOKEN,
        "rpc_url": "http://fake-rippled.invalid/",
        "network": "testnet",
        "network_id": 1,
        "max_timeout_seconds": 120,
        "max_fee_drops": 100_000,
        "log_level": "WARNING",
        "settle_poll_seconds": 0.001,
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def rpc() -> FakeRpcClient:
    return FakeRpcClient()


@pytest.fixture
def payer() -> Wallet:
    return Wallet.create()


@pytest.fixture
def seller() -> Wallet:
    return Wallet.create()


@pytest.fixture
def client(rpc: FakeRpcClient, payer: Wallet, seller: Wallet) -> Iterator[TestClient]:
    rpc.fund(payer.classic_address)
    rpc.fund(seller.classic_address)
    app = create_app(make_settings(), rpc_client=rpc)
    with TestClient(app) as test_client:
        yield test_client


def requirements(
    pay_to: str,
    *,
    amount: str = "1000",
    invoice_id: str = "inv-0001",
    network: str = "xrpl:1",
    scheme: str = "exact",
    asset: str = "XRP",
    source_tag: int | None = SOURCE_TAG,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged: dict[str, Any] = {"invoiceId": invoice_id}
    if source_tag is not None:
        merged["sourceTag"] = source_tag
    if extra:
        merged.update(extra)
    return {
        "scheme": scheme,
        "network": network,
        "amount": amount,
        "asset": asset,
        "payTo": pay_to,
        "maxTimeoutSeconds": 120,
        "extra": merged,
    }


def build_unsigned(client: TestClient, account: str, reqs: dict[str, Any]) -> dict[str, Any]:
    resp = client.post(
        "/payer/build",
        json={"account": account, "paymentRequirements": reqs},
        headers=AUTH,
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def sign_unsigned(unsigned_tx: dict[str, Any], wallet: Wallet) -> str:
    """Sign an unsignedTx exactly as the TypeScript signer would; returns the blob."""
    tx = Payment.from_xrpl(unsigned_tx)
    return sign(tx, wallet).blob()


def payload(blob: str, accepted: dict[str, Any], invoice_id: str | None = None) -> dict[str, Any]:
    inv = invoice_id if invoice_id is not None else accepted["extra"]["invoiceId"]
    return {
        "x402Version": 2,
        "accepted": accepted,
        "payload": {"signedTxBlob": blob, "invoiceId": inv},
    }


def build_sign(
    client: TestClient, wallet: Wallet, reqs: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    """/payer/build -> sign -> (blob, unsignedTx)."""
    built = build_unsigned(client, wallet.classic_address, reqs)
    return sign_unsigned(built["unsignedTx"], wallet), built["unsignedTx"]


def verify_body(payload_dict: dict[str, Any], reqs: dict[str, Any]) -> dict[str, Any]:
    return {"paymentPayload": payload_dict, "paymentRequirements": reqs}
