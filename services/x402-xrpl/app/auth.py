"""Internal auth: every route except GET /health and GET /supported needs X-Internal-Token."""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

TOKEN_HEADER = "X-Internal-Token"


async def require_internal_token(request: Request) -> None:
    """FastAPI dependency: constant-time compare of the header against X402_SERVICE_TOKEN."""
    expected: str = request.app.state.settings.service_token
    presented = request.headers.get(TOKEN_HEADER)
    if presented is None or not hmac.compare_digest(
        presented.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="unauthorized")
