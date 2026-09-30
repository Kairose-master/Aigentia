# services/x402-xrpl

Small FastAPI service that isolates the official Python **x402-xrpl 0.3.4** SDK and
**xrpl-py 5.2** behind a narrow internal HTTP API. It is responsible only for XRPL
x402 protocol compatibility (the `exact` / presigned `Payment` scheme, x402 v2):

- a real **facilitator** (`/verify`, `/settle`) that decodes and cryptographically checks
  a signed `Payment` blob against the seller's `PaymentRequirements`, submits it and waits
  for ledger validation (idempotent on the transaction hash);
- a **payer builder** (`/payer/build`) that produces the exact unsigned transaction the SDK's
  `XRPLPresignedPaymentPayer.prepare_payment` would sign, so the TypeScript side can sign it
  with its own `WalletProvider`.

What it deliberately does **not** do: hold or accept wallet seeds, sign anything, or know
about agents, jobs, prices or reputations. Mainnet (`xrpl:0`, network id 0) is refused in
configuration, at startup (the RPC's `server_info.network_id` must match) and on every request.

## Configuration

Read from the environment. When started without an explicit mapping the service first loads
the **repository-root `.env`** (and an optional `X402_DOTENV=<path>`) with python-dotenv,
never overriding variables already present in the real environment.

| Variable | Default | Notes |
| --- | --- | --- |
| `X402_SERVICE_PORT` | `8402` | Listen port (Docker `CMD` honours it). |
| `X402_SERVICE_TOKEN` | required, min 8 chars | Shared secret; sent as `X-Internal-Token`. |
| `XRPL_RPC_URL` | `https://testnet.xrpl-labs.com/` | JSON-RPC. `https://s.altnet.rippletest.net:51234` is the other public Testnet endpoint. |
| `XRPL_NETWORK` | `testnet` | `testnet` → `xrpl:1`, `devnet` → `xrpl:2`. |
| `XRPL_NETWORK_ID` | derived from `XRPL_NETWORK` | Must agree with `XRPL_NETWORK`; `0` is refused. |
| `X402_SOURCE_TAG` | `804681468` | Deployment's analytics SourceTag (informational here; the tag actually stamped comes from `extra.sourceTag`). |
| `X402_MAX_TIMEOUT_SECONDS` | `120` | Ceiling for `maxTimeoutSeconds` in `/payer/build`; bounds the `/settle` wait (`+30s`). |
| `X402_FACILITATOR_MODE` | `local` | `local` = embedded verifier/settler, `remote` = proxy to `X402_FACILITATOR_URL`. |
| `X402_FACILITATOR_URL` | – | Required when mode is `remote`. |
| `MAX_FEE_DROPS` | `100000` | Maximum `Fee` accepted by `/verify` and allowed by `/payer/build`. |
| `LOG_LEVEL` | `INFO` | JSON logs on stdout. |
| `X402_SETTLE_POLL_SECONDS` | `1.0` | Interval between `tx` polls while waiting for validation. |

## Run

```sh
make venv            # python3 -m venv .venv && pip install -r requirements-dev.txt
make dev             # uvicorn app.main:app --reload on $X402_SERVICE_PORT (default 8402)
make test            # pytest, no network (fake rippled)
make lint            # ruff check + ruff format --check + mypy app
make test-testnet    # X402_TESTNET_INTEGRATION=1: faucet two wallets, pay 1000 drops for real
docker build -t aigentia/x402-xrpl .   # python:3.11-slim, non-root, uvicorn app.main:app --port 8402
```

`docker-compose.yml` at the repo root builds this directory and injects the root `.env`.

## API contract

All bodies are JSON. Field names are the x402 v2 wire names (camelCase) and match
`packages/protocol/src/x402.ts` exactly. Every route except `GET /health` and
`GET /supported` requires `X-Internal-Token: <X402_SERVICE_TOKEN>` (constant-time
comparison; failure → `401 {"error":"unauthorized"}`).

Error envelope for HTTP-level failures: `{"error": "<snake_case_reason>", "detail"?: [...]}`.
`/verify` and `/settle` never answer 5xx/422 for bad payment input: only a body that is not
parseable JSON is `400 {"error":"invalid_json"}`; everything else is a normal
`isValid:false` / `success:false` verdict.

### `GET /health` (public)

```json
{"ok": true, "service": "x402-xrpl", "version": "0.1.0", "network": "xrpl:1", "networkId": 1,
 "rpcUrl": "https://testnet.xrpl-labs.com/", "facilitatorMode": "local", "ledgerIndex": 21169056}
```
`503` with `ok:false, ledgerIndex:null` when the RPC is unreachable.

### `GET /supported` (public)

```json
{"kinds": [{"x402Version": 2, "scheme": "exact", "network": "xrpl:1"}], "extensions": [], "signers": {}}
```

### `POST /verify`

Request (`paymentPayload` is the decoded `PAYMENT-SIGNATURE` envelope, `paymentRequirements`
is the seller's own quote for that invoice):

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": {"url": "https://api.example/services/svc_1/invoke"},
    "accepted": { ...PaymentRequirements as quoted... },
    "payload": {"signedTxBlob": "1200002280...", "invoiceId": "inv_abc"},
    "extensions": {}
  },
  "paymentRequirements": {
    "scheme": "exact", "network": "xrpl:1", "amount": "1000", "asset": "XRP",
    "payTo": "rSELLER...", "maxTimeoutSeconds": 120,
    "extra": {"invoiceId": "inv_abc", "sourceTag": 804681468, "destinationTag": 7,
              "issuer": "rISSUER... (IOU only)", "facilitator": {"id": "...", "name": "..."}}
  }
}
```

Response: `{"isValid": true, "payer": "rPAYER..."}` or
`{"isValid": false, "invalidReason": "<reason>", "payer"?: "rPAYER..."}`.

Checks, in order (each maps to an `invalidReason`):

| Reason | Meaning |
| --- | --- |
| `invalid_request` / `invalid_payload` / `invalid_requirements` | body / envelope / quote not structurally valid |
| `unsupported_x402_version` | `x402Version != 2` |
| `unsupported_scheme` | scheme is not `exact` |
| `mainnet_refused` / `unsupported_network` | `xrpl:0`, or not the configured CAIP-2 network |
| `invalid_pay_to` / `invalid_amount` / `unsupported_asset` / `missing_issuer` | quote fields (XRP drops string; IOU 3-char/40-hex + `extra.issuer`) |
| `requirements_mismatch` | `accepted` differs from `paymentRequirements` on scheme/network/amount/asset/payTo/extra.invoiceId/extra.issuer |
| `invoice_mismatch` | `payload.invoiceId != extra.invoiceId` |
| `invalid_tx_blob` / `invalid_transaction_type` | blob does not decode / not a `Payment` |
| `multisign_unsupported` / `unsupported_payment_features` | `Signers`, `Paths`, `DeliverMin`, `TicketSequence`, `Delegate`, `Sponsor`, `AccountTxnID`, XRP `SendMax`, cross-currency `SendMax` |
| `invalid_signature` | `TxnSignature` does not verify over `encode_for_signing(tx)` with `SigningPubKey` |
| `invalid_payer` / `destination_mismatch` | `Account` not a classic address / `Destination != payTo` |
| `partial_payment_not_allowed` | `tfPartialPayment` set |
| `asset_mismatch` / `amount_mismatch` | XRP: `Amount == amount` drops; IOU: currency hex, issuer and value equal, same-asset `SendMax >= value` |
| `invoice_binding_missing` | neither a `MemoData == hex(invoiceId)` memo nor `InvoiceID == SHA-256(invoiceId)` |
| `source_tag_mismatch` / `destination_tag_mismatch` | tags disagree with `extra` (a `DestinationTag` not requested is also rejected) |
| `invalid_fee` | `Fee` not a drops string in `1..MAX_FEE_DROPS` |
| `missing_last_ledger_sequence` / `missing_sequence` / `network_mismatch` | required fields absent, or `NetworkID` for another network |
| `expired` | `LastLedgerSequence <= latest validated ledger` |
| `account_not_found` / `sequence_already_used` / `signer_not_authorized` / `insufficient_funds` | `account_info` checks (balance must cover `Amount + Fee` for XRP; signer must be the account or its `RegularKey`) |
| `rpc_unavailable` | rippled could not be reached for the ledger-state checks |

### `POST /settle`

Same request body as `/verify`. Response is the x402 `SettlementResponse`:

```json
{"success": true, "transaction": "E3F1...64 hex", "network": "xrpl:1", "payer": "rPAYER...",
 "extensions": {"ledgerIndex": 21169060, "deliveredAmount": "1000", "closeTime": "2026-09-30T12:20:21Z"}}
```
```json
{"success": false, "errorReason": "tecUNFUNDED_PAYMENT", "transaction": "", "network": "xrpl:1",
 "payer": "rPAYER...", "extensions": {"transactionHash": "E3F1...", "ledgerIndex": 21169060}}
```

Flow: offline checks → hash = SHA-512-half(`"TXN\0"` + blob) (identical to xrpl-py's
`Transaction.get_hash`) → **idempotency**: `tx` lookup; an already-validated `tesSUCCESS`
returns the same settlement with no resubmission (even after the quote expired) → ledger-state
checks → `submit` (blob) → poll `tx` every `X402_SETTLE_POLL_SECONDS` until validated, until the
latest validated ledger reaches `LastLedgerSequence` (`expired_before_validation`), or until
`min(maxTimeoutSeconds, X402_MAX_TIMEOUT_SECONDS) + 30s` (`settlement_timeout`).
`tem*` and `tef*` preliminary results fail immediately with that code, except `tefPAST_SEQ` /
`tefALREADY` which fall through to the hash poll. `tec*` transactions are reported with their final
`meta.TransactionResult`. `settlement_status_unknown` means the submit call itself failed and the
outcome must be checked via `GET /tx/{hash}` (the hash is in `extensions.transactionHash`).

### `POST /payer/build`

```json
{"account": "rPAYER...", "paymentRequirements": { ...as quoted... },
 "resource": {"url": "..."}, "maxFeeDrops": 10000}
```
→
```json
{"invoiceId": "inv_abc",
 "unsignedTx": {"TransactionType": "Payment", "Account": "rPAYER...", "Destination": "rSELLER...",
   "Amount": "1000", "Fee": "10", "Sequence": 123, "LastLedgerSequence": 21169082,
   "SourceTag": 804681468, "InvoiceID": "<SHA-256(invoiceId) hex>",
   "Memos": [{"Memo": {"MemoData": "<hex(invoiceId)>"}}]},
 "lastLedgerSequence": 21169082, "networkId": 1}
```

`unsignedTx` is xrpl.js-compatible PascalCase JSON with `SigningPubKey`/`TxnSignature` absent.
It is built exactly like `XRPLPresignedPaymentPayer.prepare_payment` (invoice binding "both",
typed facilitator memo when `extra.facilitator.id` is present, `SourceTag`/`DestinationTag`
from `extra`, XRP or same-asset IOU `SendMax`, `LastLedgerSequence = latest validated +
ceil(maxTimeoutSeconds/5) + 2`, `Sequence`/`Fee` autofilled, RPC network asserted,
`Fee <= min(maxFeeDrops, MAX_FEE_DROPS)`).

`400 {"error": <reason>}` for `invalid_account`, `invalid_requirements`, `unsupported_scheme`,
`mainnet_refused`, `unsupported_network`, `unsupported_asset`, `missing_issuer`,
`invalid_amount`, `invalid_pay_to`, `missing_invoice_id`, `max_timeout_exceeds_policy`,
`fee_exceeds_payer_policy`, `rpc_network_mismatch`, `account_not_found`, `invalid_request`
(body shape); `503 {"error":"rpc_unavailable"}` when rippled is down.

### `GET /tx/{hash}`

```json
{"found": true, "validated": true, "result": "tesSUCCESS", "ledgerIndex": 21169060,
 "deliveredAmount": "1000", "account": "rPAYER...", "destination": "rSELLER...",
 "closeTime": "2026-09-30T12:20:21Z"}
```
`404 {"found": false, "error": "tx_not_found"}` when rippled does not know the hash,
`400 {"error":"invalid_tx_hash"}` for anything that is not 64 hex characters.

## curl examples

```sh
export T=devtoken   # X402_SERVICE_TOKEN

curl -s localhost:8402/health
curl -s localhost:8402/supported

curl -s -X POST localhost:8402/payer/build -H "X-Internal-Token: $T" -H 'content-type: application/json' -d '{
  "account": "rPAYER...",
  "paymentRequirements": {"scheme":"exact","network":"xrpl:1","amount":"1000","asset":"XRP",
    "payTo":"rSELLER...","maxTimeoutSeconds":120,"extra":{"invoiceId":"inv_abc","sourceTag":804681468}}
}'

# sign unsignedTx with xrpl.js (Wallet.sign) -> tx_blob, then:
curl -s -X POST localhost:8402/verify -H "X-Internal-Token: $T" -H 'content-type: application/json' -d '{
  "paymentPayload": {"x402Version":2,"accepted":{...same requirements...},
                     "payload":{"signedTxBlob":"<tx_blob>","invoiceId":"inv_abc"}},
  "paymentRequirements": {...same requirements...}
}'
curl -s -X POST localhost:8402/settle -H "X-Internal-Token: $T" -H 'content-type: application/json' -d @same-body.json
curl -s localhost:8402/tx/<64-hex hash> -H "X-Internal-Token: $T"
```

## Network facts

- Testnet JSON-RPC: `https://testnet.xrpl-labs.com/` (default) or `https://s.altnet.rippletest.net:51234`.
- Faucet: `POST https://faucet.altnet.rippletest.net/accounts` with `{"destination": "<address>"}`
  (an empty `{}` body returns a brand-new funded account including its seed — never log it).
- Mainnet (`xrpl:0`) is refused at every layer.

## Tests

`tests/conftest.py` has `FakeRpcClient`, an in-memory rippled implementing `server_info`,
`ledger`, `fee`, `account_info`, `tx` and `submit` with a validated-ledger counter, so the whole
build → sign (xrpl-py `Wallet`, in the test only) → verify → settle flow runs offline.
`tests/test_testnet_integration.py` is the opt-in real round trip (`X402_TESTNET_INTEGRATION=1`).
