from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings, SettingsError
from tests.conftest import AUTH, FakeRpcClient, make_settings

ZERO_HASH = "0" * 64


def test_health_and_supported_are_public(client: TestClient, rpc: FakeRpcClient) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    body = health.json()
    assert body["ok"] is True
    assert body["service"] == "x402-xrpl"
    assert body["network"] == "xrpl:1"
    assert body["networkId"] == 1
    assert body["facilitatorMode"] == "local"
    assert body["ledgerIndex"] == rpc.validated_ledger
    assert body["rpcUrl"] == "http://fake-rippled.invalid/"
    assert isinstance(body["version"], str)

    supported = client.get("/supported")
    assert supported.status_code == 200
    assert supported.json() == {
        "kinds": [{"x402Version": 2, "scheme": "exact", "network": "xrpl:1"}],
        "extensions": [],
        "signers": {},
    }


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/verify"),
        ("POST", "/settle"),
        ("POST", "/payer/build"),
        ("GET", f"/tx/{ZERO_HASH}"),
    ],
)
def test_internal_routes_require_token(client: TestClient, method: str, path: str) -> None:
    missing = client.request(method, path, json={})
    assert missing.status_code == 401
    assert missing.json() == {"error": "unauthorized"}

    wrong = client.request(method, path, json={}, headers={"X-Internal-Token": "nope-nope"})
    assert wrong.status_code == 401


def test_unparsable_json_is_400(client: TestClient) -> None:
    resp = client.post(
        "/verify", content=b"{not json", headers={**AUTH, "content-type": "application/json"}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": "invalid_json"}


def test_wrong_shape_is_not_500(client: TestClient) -> None:
    resp = client.post("/verify", json=[1, 2, 3], headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"isValid": False, "invalidReason": "invalid_request"}

    resp = client.post("/settle", json={"paymentPayload": "x"}, headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["success"] is False
    assert resp.json()["errorReason"] == "invalid_payload"
    assert resp.json()["transaction"] == ""


def test_startup_refuses_wrong_network() -> None:
    with (
        pytest.raises(RuntimeError, match="network_id=2"),
        TestClient(create_app(make_settings(), rpc_client=FakeRpcClient(network_id=2))),
    ):
        pass
    with (
        pytest.raises(RuntimeError, match="Mainnet"),
        TestClient(create_app(make_settings(), rpc_client=FakeRpcClient(network_id=0))),
    ):
        pass


def test_settings_refuse_mainnet_and_bad_values() -> None:
    with pytest.raises(SettingsError, match="Mainnet"):
        Settings.from_env({"X402_SERVICE_TOKEN": "devtoken1", "XRPL_NETWORK_ID": "0"})
    with pytest.raises(SettingsError, match="XRPL_NETWORK"):
        Settings.from_env(
            {"X402_SERVICE_TOKEN": "devtoken1", "XRPL_NETWORK": "testnet", "XRPL_NETWORK_ID": "2"}
        )
    with pytest.raises(SettingsError, match="service_token"):
        Settings.from_env({"X402_SERVICE_TOKEN": "short"})
    with pytest.raises(SettingsError, match="X402_FACILITATOR_URL"):
        Settings.from_env({"X402_SERVICE_TOKEN": "devtoken1", "X402_FACILITATOR_MODE": "remote"})
    with pytest.raises(SettingsError):
        Settings.from_env({"X402_SERVICE_TOKEN": "devtoken1", "X402_SERVICE_PORT": "abc"})


def test_settings_defaults_and_caip2() -> None:
    s = Settings.from_env({"X402_SERVICE_TOKEN": "devtoken1", "LOG_LEVEL": "info"})
    assert s.caip2 == "xrpl:1"
    assert s.network_id == 1
    assert s.service_port == 8402
    assert s.source_tag == 804681468
    assert s.max_timeout_seconds == 120
    assert s.max_fee_drops == 100_000
    assert s.rpc_url == "https://testnet.xrpl-labs.com/"
    assert s.log_level == "INFO"

    dev = Settings.from_env({"X402_SERVICE_TOKEN": "devtoken1", "XRPL_NETWORK": "devnet"})
    assert dev.caip2 == "xrpl:2"
    assert dev.network_id == 2
