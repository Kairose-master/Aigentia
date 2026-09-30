"""FastAPI application: the narrow internal HTTP API in front of x402-xrpl / xrpl-py.

Routes
  GET  /health            public
  GET  /supported         public
  POST /verify            X-Internal-Token
  POST /settle            X-Internal-Token
  POST /payer/build       X-Internal-Token
  GET  /tx/{hash}         X-Internal-Token
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from xrpl.asyncio.clients import AsyncJsonRpcClient
from xrpl.asyncio.clients.async_client import AsyncClient

from app import __version__
from app.auth import require_internal_token
from app.facilitator import Facilitator, LocalFacilitator, RemoteFacilitator
from app.logconfig import configure_logging
from app.payer import PayerBuildError, build_unsigned_payment
from app.rpc import RpcError, latest_validated_ledger, lookup_tx, server_network_id
from app.schemas import PayerBuildRequest
from app.settings import MAINNET_NETWORK_ID, Settings

SERVICE_NAME = "x402-xrpl"
TX_HASH_RE = re.compile(r"^[0-9A-Fa-f]{64}$")

log = logging.getLogger("x402.main")


async def _read_json(request: Request) -> Any:
    """Body as JSON; 400 when it is not parseable (the only structural 4xx on verify/settle)."""
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc


def create_app(
    settings: Settings | None = None, *, rpc_client: AsyncClient | None = None
) -> FastAPI:
    """Application factory. ``rpc_client`` lets tests inject a fake rippled."""
    cfg = settings or Settings.from_env()
    configure_logging(cfg.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = rpc_client or AsyncJsonRpcClient(cfg.rpc_url)
        network_id, info = await server_network_id(client)  # RpcError -> startup fails
        if network_id == MAINNET_NETWORK_ID:
            raise RuntimeError("refusing to start: RPC endpoint is XRPL Mainnet (network_id 0)")
        if network_id != cfg.network_id:
            raise RuntimeError(
                f"refusing to start: RPC reports network_id={network_id!r}, "
                f"configured XRPL_NETWORK_ID={cfg.network_id}"
            )
        facilitator: Facilitator = (
            LocalFacilitator(cfg, client)
            if cfg.facilitator_mode == "local"
            else RemoteFacilitator(cfg)
        )
        app.state.rpc = client
        app.state.facilitator = facilitator
        log.info(
            "startup",
            extra={
                "service": SERVICE_NAME,
                "version": __version__,
                "network": cfg.caip2,
                "rpcUrl": cfg.rpc_url,
                "facilitatorMode": cfg.facilitator_mode,
                "buildVersion": info.get("build_version"),
            },
        )
        try:
            yield
        finally:
            await facilitator.aclose()
            log.info("shutdown", extra={"service": SERVICE_NAME})

    app = FastAPI(
        title="x402-xrpl",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.settings = cfg

    # ---- error shaping ----------------------------------------------------------------

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "http_error"
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        problems = [
            {"loc": [str(p) for p in err.get("loc", ())], "msg": str(err.get("msg", ""))}
            for err in exc.errors()
        ]
        return JSONResponse({"error": "invalid_request", "detail": problems}, status_code=400)

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", extra={"errorType": type(exc).__name__})
        return JSONResponse({"error": "internal_error"}, status_code=500)

    @app.middleware("http")
    async def _access_log(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        started = time.perf_counter()
        response = await call_next(request)
        log.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000, 1),
            },
        )
        return response

    # ---- public -----------------------------------------------------------------------

    public = APIRouter()

    @public.get("/health")
    async def health(request: Request) -> JSONResponse:
        ledger_index: int | None
        try:
            ledger_index = await latest_validated_ledger(request.app.state.rpc)
            ok = True
        except RpcError as exc:
            log.warning("health: rpc unavailable", extra={"error": str(exc)})
            ledger_index = None
            ok = False
        body = {
            "ok": ok,
            "service": SERVICE_NAME,
            "version": __version__,
            "network": cfg.caip2,
            "networkId": cfg.network_id,
            "rpcUrl": cfg.rpc_url,
            "facilitatorMode": cfg.facilitator_mode,
            "ledgerIndex": ledger_index,
        }
        return JSONResponse(body, status_code=200 if ok else 503)

    @public.get("/supported")
    async def supported() -> dict[str, Any]:
        return {
            "kinds": [{"x402Version": 2, "scheme": "exact", "network": cfg.caip2}],
            "extensions": [],
            "signers": {},
        }

    # ---- internal (token) -------------------------------------------------------------

    internal = APIRouter(dependencies=[Depends(require_internal_token)])

    @internal.post("/verify")
    async def verify(request: Request) -> dict[str, Any]:
        body = await _read_json(request)
        facilitator: Facilitator = request.app.state.facilitator
        return await facilitator.verify(body)

    @internal.post("/settle")
    async def settle(request: Request) -> dict[str, Any]:
        body = await _read_json(request)
        facilitator: Facilitator = request.app.state.facilitator
        return await facilitator.settle(body)

    @internal.post("/payer/build")
    async def payer_build(request: Request, body: PayerBuildRequest) -> JSONResponse:
        try:
            built = await build_unsigned_payment(
                settings=cfg,
                client=request.app.state.rpc,
                account=body.account,
                requirements_raw=body.paymentRequirements,
                max_fee_drops=body.maxFeeDrops,
            )
        except PayerBuildError as exc:
            status = 503 if exc.reason == "rpc_unavailable" else 400
            log.info("payer/build rejected", extra={"reason": exc.reason, "status": status})
            return JSONResponse({"error": exc.reason}, status_code=status)
        return JSONResponse(built)

    @internal.get("/tx/{tx_hash}")
    async def tx_status(request: Request, tx_hash: str) -> JSONResponse:
        if not TX_HASH_RE.match(tx_hash):
            return JSONResponse({"error": "invalid_tx_hash"}, status_code=400)
        try:
            found = await lookup_tx(request.app.state.rpc, tx_hash.upper())
        except RpcError as exc:
            log.warning("tx: rpc unavailable", extra={"error": str(exc)})
            return JSONResponse({"error": "rpc_unavailable"}, status_code=503)
        if found is None:
            return JSONResponse({"found": False, "error": "tx_not_found"}, status_code=404)
        return JSONResponse(found.to_wire())

    app.include_router(public)
    app.include_router(internal)
    return app


_default_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    """``uvicorn app.main:app`` builds the app lazily from the environment."""
    global _default_app  # noqa: PLW0603
    if name == "app":
        if _default_app is None:
            _default_app = create_app()
        return _default_app
    raise AttributeError(name)
