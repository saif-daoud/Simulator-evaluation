from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


ALLOWED_RESPONSE_FIELDS = {
    "model",
    "instructions",
    "input",
    "max_output_tokens",
    "text",
    "reasoning",
    "safety_identifier",
    "store",
}


@dataclass(frozen=True)
class RelayConfig:
    token: str
    provider_api_key: str
    provider_base_url: str
    model: str
    max_request_bytes: int
    max_output_tokens: int
    timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "RelayConfig":
        return cls(
            token=os.getenv("RELAY_TOKEN", "").strip(),
            provider_api_key=os.getenv("PROVIDER_API_KEY", "").strip(),
            provider_base_url=os.getenv(
                "PROVIDER_BASE_URL",
                "https://qcri-sakina-02.services.ai.azure.com/api/projects/"
                "qcri-sakina-02/openai/v1/",
            ).strip().rstrip("/"),
            model=os.getenv("PROVIDER_MODEL", "gpt-4.1").strip(),
            max_request_bytes=int(os.getenv("RELAY_MAX_REQUEST_BYTES", str(2 * 1024 * 1024))),
            max_output_tokens=int(os.getenv("RELAY_MAX_OUTPUT_TOKENS", "4000")),
            timeout_seconds=float(os.getenv("RELAY_TIMEOUT_SECONDS", "180")),
        )

    @property
    def configured(self) -> bool:
        return len(self.token) >= 32 and bool(self.provider_api_key) and bool(self.provider_base_url)


@dataclass(frozen=True)
class UpstreamResponse:
    status_code: int
    body: bytes
    content_type: str = "application/json"


class RelayValidationError(ValueError):
    pass


def validate_response_payload(payload: Any, config: RelayConfig) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RelayValidationError("The request body must be a JSON object.")
    unexpected = sorted(set(payload) - ALLOWED_RESPONSE_FIELDS)
    if unexpected:
        raise RelayValidationError(f"Unsupported request field: {unexpected[0]}.")
    if payload.get("model") != config.model:
        raise RelayValidationError(f"Only the configured model ({config.model}) is allowed.")
    instructions = payload.get("instructions")
    if not isinstance(instructions, str) or not instructions.strip():
        raise RelayValidationError("instructions must be a non-empty string.")
    if "input" not in payload or not isinstance(payload["input"], (str, list)):
        raise RelayValidationError("input must be a string or an array.")
    max_output_tokens = payload.get("max_output_tokens")
    if (
        isinstance(max_output_tokens, bool)
        or not isinstance(max_output_tokens, int)
        or max_output_tokens < 1
        or max_output_tokens > config.max_output_tokens
    ):
        raise RelayValidationError(
            f"max_output_tokens must be an integer between 1 and {config.max_output_tokens}."
        )
    if "text" in payload and not isinstance(payload["text"], dict):
        raise RelayValidationError("text must be an object.")
    if "reasoning" in payload and not isinstance(payload["reasoning"], dict):
        raise RelayValidationError("reasoning must be an object.")
    if "safety_identifier" in payload:
        identifier = payload["safety_identifier"]
        if not isinstance(identifier, str) or not (1 <= len(identifier) <= 64):
            raise RelayValidationError("safety_identifier must contain 1-64 characters.")

    forwarded = {key: payload[key] for key in ALLOWED_RESPONSE_FIELDS if key in payload}
    forwarded["model"] = config.model
    forwarded["store"] = False
    return forwarded


def _message_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        if parts:
            return "\n".join(parts)
    raise RelayValidationError("Every input message must contain text content.")


def build_chat_completion_payload(payload: dict[str, Any], config: RelayConfig) -> dict[str, Any]:
    messages: list[dict[str, str]] = [
        {"role": "system", "content": payload["instructions"].strip()}
    ]
    input_value = payload["input"]
    if isinstance(input_value, str):
        messages.append({"role": "user", "content": input_value})
    else:
        for item in input_value:
            if not isinstance(item, dict):
                raise RelayValidationError("Every input item must be a message object.")
            role = item.get("role")
            if role not in {"user", "assistant"}:
                raise RelayValidationError("Input message roles must be user or assistant.")
            messages.append({"role": role, "content": _message_content(item.get("content"))})

    chat_payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "max_completion_tokens": payload["max_output_tokens"],
    }
    text_options = payload.get("text") or {}
    output_format = text_options.get("format")
    if output_format is not None:
        if (
            not isinstance(output_format, dict)
            or output_format.get("type") != "json_schema"
            or not isinstance(output_format.get("name"), str)
            or not isinstance(output_format.get("schema"), dict)
        ):
            raise RelayValidationError("text.format must contain a named JSON schema.")
        chat_payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": output_format["name"],
                "strict": output_format.get("strict", True),
                "schema": output_format["schema"],
            },
        }
        chat_payload["temperature"] = 0.0
    else:
        chat_payload["temperature"] = 0.7
        chat_payload["top_p"] = 0.9
    return chat_payload


def _responses_compatible_body(body: bytes) -> bytes:
    try:
        payload = json.loads(body)
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("empty completion")
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("The provider returned no chat completion text.") from exc
    return json.dumps(
        {
            "id": payload.get("id"),
            "model": payload.get("model"),
            "output_text": content.strip(),
            "usage": payload.get("usage"),
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def forward_response_payload(payload: dict[str, Any], config: RelayConfig) -> UpstreamResponse:
    chat_payload = build_chat_completion_payload(payload, config)
    body = json.dumps(chat_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{config.provider_base_url}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config.provider_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "cbt-simulator-evaluation-relay/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout_seconds) as response:
            return UpstreamResponse(
                status_code=response.status,
                body=_responses_compatible_body(response.read()),
                content_type="application/json",
            )
    except urllib.error.HTTPError as exc:
        return UpstreamResponse(
            status_code=exc.code,
            body=exc.read(),
            content_type=exc.headers.get_content_type() if exc.headers else "application/json",
        )
