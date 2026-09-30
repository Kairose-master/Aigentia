"""Service configuration.

Values are read from the process environment. When ``Settings.from_env()`` is called
without an explicit mapping it first loads the repository-root ``.env`` (and an optional
``X402_DOTENV`` file) through python-dotenv **without** overriding variables that are
already set in the real environment.

Mainnet (XRPL network id 0 / CAIP-2 ``xrpl:0``) is refused here, again at startup
(``server_info`` must agree) and on every request that names a network.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

NetworkName = Literal["testnet", "devnet"]
FacilitatorMode = Literal["local", "remote"]

NETWORK_IDS: dict[str, int] = {"testnet": 1, "devnet": 2}
SUPPORTED_NETWORK_IDS = frozenset(NETWORK_IDS.values())
MAINNET_NETWORK_ID = 0
MAINNET_CAIP2 = "xrpl:0"

# Both are valid public Testnet JSON-RPC endpoints; xrpl-labs is the default because
# s.altnet.rippletest.net:51234 is unreachable from some environments.
PUBLIC_TESTNET_RPC_URLS = (
    "https://testnet.xrpl-labs.com/",
    "https://s.altnet.rippletest.net:51234",
)
DEFAULT_RPC_URL = PUBLIC_TESTNET_RPC_URLS[0]
DEFAULT_SOURCE_TAG = 804681468
MAX_UINT32 = 0xFFFFFFFF

LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

# services/x402-xrpl/app/settings.py -> repo root is three levels up.
REPO_ROOT = Path(__file__).resolve().parents[3]


class SettingsError(RuntimeError):
    """Raised when the environment does not describe a valid, safe configuration."""


def load_env_files() -> list[Path]:
    """Load ``.env`` files into ``os.environ`` without overriding real variables.

    Order: an explicit ``X402_DOTENV`` path (if set), then the repository root ``.env``.
    Returns the list of files that were actually loaded.
    """
    candidates: list[Path] = []
    explicit = os.environ.get("X402_DOTENV")
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.append(REPO_ROOT / ".env")

    loaded: list[Path] = []
    for path in candidates:
        if path.is_file():
            load_dotenv(path, override=False)
            loaded.append(path)
    return loaded


class Settings(BaseModel):
    """Validated service settings (immutable)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    service_port: int = Field(default=8402, ge=1, le=65535)
    service_token: str = Field(min_length=8)
    rpc_url: str = DEFAULT_RPC_URL
    network: NetworkName = "testnet"
    network_id: int = NETWORK_IDS["testnet"]
    source_tag: int = Field(default=DEFAULT_SOURCE_TAG, ge=0, le=MAX_UINT32)
    max_timeout_seconds: int = Field(default=120, ge=1, le=3600)
    facilitator_mode: FacilitatorMode = "local"
    facilitator_url: str | None = None
    max_fee_drops: int = Field(default=100_000, ge=1)
    log_level: str = "INFO"
    # Interval between `tx` polls while waiting for validation (tests lower it).
    settle_poll_seconds: float = Field(default=1.0, gt=0, le=30)

    @field_validator("rpc_url", "facilitator_url")
    @classmethod
    def _http_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value.startswith(("http://", "https://")):
            raise ValueError("must be an http(s) URL")
        return value

    @field_validator("network_id")
    @classmethod
    def _refuse_mainnet(cls, value: int) -> int:
        if value == MAINNET_NETWORK_ID:
            raise ValueError("network id 0 (XRPL Mainnet) is refused by this service")
        if value not in SUPPORTED_NETWORK_IDS:
            raise ValueError(f"unsupported network id {value} (expected one of 1, 2)")
        return value

    @field_validator("log_level")
    @classmethod
    def _log_level(cls, value: str) -> str:
        upper = value.strip().upper()
        if upper not in LOG_LEVELS:
            raise ValueError(f"must be one of {', '.join(LOG_LEVELS)}")
        return upper

    @model_validator(mode="after")
    def _consistent(self) -> Settings:
        expected = NETWORK_IDS[self.network]
        if self.network_id != expected:
            raise ValueError(
                f"XRPL_NETWORK={self.network} implies XRPL_NETWORK_ID={expected}, "
                f"got {self.network_id}"
            )
        if self.facilitator_mode == "remote" and not self.facilitator_url:
            raise ValueError("X402_FACILITATOR_URL is required when X402_FACILITATOR_MODE=remote")
        return self

    @property
    def caip2(self) -> str:
        """CAIP-2 network identifier, e.g. ``xrpl:1`` for Testnet."""
        return f"xrpl:{self.network_id}"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Build settings from ``env`` (defaults to ``os.environ`` after loading .env files)."""
        if env is None:
            load_env_files()
            env = os.environ

        raw: dict[str, Any] = {}

        def put(field: str, var: str, convert: Callable[[str], Any] = str) -> None:
            value = env.get(var)
            if value is None or value.strip() == "":
                return
            try:
                raw[field] = convert(value.strip())
            except (TypeError, ValueError) as exc:
                raise SettingsError(f"{var}: {exc}") from exc

        put("service_port", "X402_SERVICE_PORT", int)
        put("service_token", "X402_SERVICE_TOKEN")
        put("rpc_url", "XRPL_RPC_URL")
        put("network", "XRPL_NETWORK", str.lower)
        put("network_id", "XRPL_NETWORK_ID", int)
        put("source_tag", "X402_SOURCE_TAG", int)
        put("max_timeout_seconds", "X402_MAX_TIMEOUT_SECONDS", int)
        put("facilitator_mode", "X402_FACILITATOR_MODE", str.lower)
        put("facilitator_url", "X402_FACILITATOR_URL")
        put("max_fee_drops", "MAX_FEE_DROPS", int)
        put("log_level", "LOG_LEVEL")
        put("settle_poll_seconds", "X402_SETTLE_POLL_SECONDS", float)

        # XRPL_NETWORK_ID defaults to the id implied by XRPL_NETWORK.
        if "network_id" not in raw and raw.get("network") in NETWORK_IDS:
            raw["network_id"] = NETWORK_IDS[str(raw["network"])]

        try:
            return cls(**raw)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in err['loc']) or 'settings'}: {err['msg']}"
                for err in exc.errors()
            )
            raise SettingsError(f"invalid configuration: {problems}") from exc
