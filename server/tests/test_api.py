from __future__ import annotations

import importlib
import json
import sys
from email.message import Message

from fastapi.testclient import TestClient

import server.relay as relay_module
from server.relay import (
    RelayConfig,
    UpstreamResponse,
    build_chat_completion_payload,
    forward_response_payload,
)


RELAY_TOKEN = "test-relay-token-that-is-at-least-thirty-two-characters"


def load_client(monkeypatch):
    monkeypatch.setenv("RELAY_TOKEN", RELAY_TOKEN)
    monkeypatch.setenv("PROVIDER_API_KEY", "test-provider-key")
    monkeypatch.setenv("PROVIDER_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-4.1")
    sys.modules.pop("server.app", None)
    module = importlib.import_module("server.app")
    return module, TestClient(module.app)


def test_default_qcri_project_endpoint(monkeypatch):
    monkeypatch.delenv("PROVIDER_BASE_URL", raising=False)
    config = RelayConfig.from_environment()
    assert config.provider_base_url == (
        "https://qcri-sakina-02.services.ai.azure.com/api/projects/"
        "qcri-sakina-02/openai/v1"
    )


def test_translates_responses_schema_to_chat_completions(monkeypatch):
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-4.1")
    config = RelayConfig.from_environment()
    translated = build_chat_completion_payload(request_payload(), config)
    assert translated == {
        "model": "gpt-4.1",
        "messages": [
            {"role": "system", "content": "Return JSON."},
            {"role": "user", "content": "Hello"},
        ],
        "max_completion_tokens": 500,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "result",
                "strict": True,
                "schema": {},
            },
        },
        "temperature": 0.0,
    }


def test_accepts_gpt_5_1_responses_options_without_forwarding_them(monkeypatch):
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-5.1")
    config = RelayConfig.from_environment()
    source = request_payload(
        model="gpt-5.1",
        reasoning={"effort": "none"},
        text={
            "verbosity": "low",
            "format": {"type": "json_schema", "name": "result", "strict": True, "schema": {}},
        },
    )
    validated = relay_module.validate_response_payload(source, config)
    translated = build_chat_completion_payload(validated, config)
    assert translated["model"] == "gpt-5.1"
    assert "reasoning" not in translated
    assert "verbosity" not in translated


def test_translates_patient_act_conversation_history(monkeypatch):
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-4.1")
    config = RelayConfig.from_environment()
    source = request_payload(
        input=[
            {"role": "user", "content": "What would you like to discuss?"},
            {"role": "assistant", "content": "I have been worried this week."},
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "What happens when you worry?"}],
            },
        ]
    )
    translated = build_chat_completion_payload(source, config)
    assert translated["messages"] == [
        {"role": "system", "content": "Return JSON."},
        {"role": "user", "content": "What would you like to discuss?"},
        {"role": "assistant", "content": "I have been worried this week."},
        {"role": "user", "content": "What happens when you worry?"},
    ]


def test_translates_topas_plain_text_request(monkeypatch):
    monkeypatch.setenv("PROVIDER_MODEL", "gpt-4.1")
    config = RelayConfig.from_environment()
    source = request_payload()
    source.pop("text")
    translated = build_chat_completion_payload(source, config)
    assert "response_format" not in translated
    assert translated["temperature"] == 0.7
    assert translated["top_p"] == 0.9


def test_provider_call_uses_chat_completions_and_returns_output_text(monkeypatch):
    config = RelayConfig(
        token=RELAY_TOKEN,
        provider_api_key="provider-key",
        provider_base_url="https://provider.example/openai/v1",
        model="gpt-4.1",
        max_request_bytes=1024,
        max_output_tokens=1000,
        timeout_seconds=30,
    )
    captured = {}

    class FakeResponse:
        status = 200
        headers = Message()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(
                {
                    "id": "chatcmpl-test",
                    "model": "gpt-4.1",
                    "choices": [{"message": {"content": '{"value":"ok"}'}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4},
                }
            ).encode()

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["payload"] = json.loads(request.data)
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(relay_module.urllib.request, "urlopen", fake_urlopen)
    upstream = forward_response_payload(request_payload(), config)
    assert captured["url"] == "https://provider.example/openai/v1/chat/completions"
    assert captured["payload"]["response_format"]["type"] == "json_schema"
    assert captured["timeout"] == 30
    assert upstream.status_code == 200
    assert json.loads(upstream.body)["output_text"] == '{"value":"ok"}'


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
