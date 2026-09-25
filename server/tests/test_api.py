from __future__ import annotations

import importlib
import json
import sys

from fastapi.testclient import TestClient

from server.relay import UpstreamResponse


RELAY_TOKEN = "test-relay-token-that-is-at-least-thirty-two-characters"


def load_client(monkeypatch):
    monkeypatch.setenv("RELAY_TOKEN", RELAY_TOKEN)
    monkeypatch.setenv("PROVIDER_API_KEY", "test-provider-key")
    monkeypatch.setenv("PROVIDER_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-4.1")
    sys.modules.pop("server.app", None)
    module = importlib.import_module("server.app")
    return module, TestClient(module.app)


def request_payload(**updates):
    payload = {
        "model": "gpt-4.1",
        "instructions": "Return JSON.",
        "input": "Hello",
        "max_output_tokens": 500,
        "text": {"format": {"type": "json_schema", "name": "result", "strict": True, "schema": {}}},
        "safety_identifier": "anonymous-id",
        "store": True,
    }
    payload.update(updates)
    return payload


def test_health_and_authentication(monkeypatch):
    _, client = load_client(monkeypatch)
    with client:
        health = client.get("/api/health")
        missing = client.post("/api/responses", json=request_payload())
        wrong = client.post(
            "/api/responses",
            headers={"Authorization": "Bearer wrong-token"},
            json=request_payload(),
        )
    assert health.json() == {
        "status": "ok",
        "service": "cbt-simulator-evaluation-relay",
        "configured": True,
        "model": "gpt-4.1",
    }
    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_allowlists_and_forwards_responses_request(monkeypatch):
    module, client = load_client(monkeypatch)
    captured = {}

    def fake_forward(payload, config):
        captured["payload"] = payload
        captured["config"] = config
        return UpstreamResponse(
            status_code=200,
            body=json.dumps({"output_text": "{\"value\":\"ok\"}"}).encode(),
        )

    monkeypatch.setattr(module, "forward_response_payload", fake_forward)
    with client:
        response = client.post(
            "/api/responses",
            headers={"Authorization": f"Bearer {RELAY_TOKEN}"},
            json=request_payload(),
        )
    assert response.status_code == 200
    assert response.json()["output_text"] == '{"value":"ok"}'
    assert captured["payload"]["model"] == "gpt-4.1"
    assert captured["payload"]["store"] is False
    assert captured["config"].provider_base_url == "https://provider.example/v1"


def test_rejects_other_models_and_fields(monkeypatch):
    _, client = load_client(monkeypatch)
    headers = {"Authorization": f"Bearer {RELAY_TOKEN}"}
    with client:
        other_model = client.post(
            "/api/responses", headers=headers, json=request_payload(model="gpt-5.1")
        )
        unexpected = client.post("/api/responses", headers=headers, json=request_payload(tools=[]))
    assert other_model.status_code == 422
    assert unexpected.status_code == 422


def test_preserves_provider_error_shape(monkeypatch):
    module, client = load_client(monkeypatch)
    monkeypatch.setattr(
        module,
        "forward_response_payload",
        lambda _payload, _config: UpstreamResponse(
            status_code=429,
            body=b'{"error":{"message":"Rate limited"}}',
        ),
    )
    with client:
        response = client.post(
            "/api/responses",
            headers={"Authorization": f"Bearer {RELAY_TOKEN}"},
            json=request_payload(),
        )
    assert response.status_code == 429
    assert response.json() == {"error": {"message": "Rate limited"}}
