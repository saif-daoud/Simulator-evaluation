from __future__ import annotations

from fastapi.testclient import TestClient

from server import gateway
from server.gateway import GatewayConfig, route_target


CONFIG = GatewayConfig(
    existing_origin="http://127.0.0.1:8000",
    relay_origin="http://127.0.0.1:8001",
    timeout_seconds=10,
)


def test_routes_existing_website_paths_unchanged():
    assert route_target("/", "", CONFIG) == "http://127.0.0.1:8000/"
    assert route_target("/api/auth/login", "next=1", CONFIG) == (
        "http://127.0.0.1:8000/api/auth/login?next=1"
    )
    assert route_target("/assets/app.js", "", CONFIG) == "http://127.0.0.1:8000/assets/app.js"


def test_strips_only_the_simulator_relay_prefix():
    assert route_target("/simulator-evaluation-relay/api/health", "", CONFIG) == (
        "http://127.0.0.1:8001/api/health"
    )
    assert route_target("/simulator-evaluation-relay/api/responses", "", CONFIG) == (
        "http://127.0.0.1:8001/api/responses"
    )


def test_gateway_forwards_relay_request(monkeypatch):
    captured = {}

    def fake_forward(method, target, headers, body, timeout_seconds):
        captured.update(method=method, target=target, headers=headers, body=body, timeout=timeout_seconds)
        return 200, [("Content-Type", "application/json")], b'{"ok":true}'

    monkeypatch.setattr(gateway, "_forward", fake_forward)
    response = TestClient(gateway.app).post(
        "/simulator-evaluation-relay/api/responses",
        headers={"Authorization": "Bearer test-token"},
        content=b"{}",
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert captured["target"] == "http://127.0.0.1:8001/api/responses"
    assert captured["headers"]["authorization"] == "Bearer test-token"
