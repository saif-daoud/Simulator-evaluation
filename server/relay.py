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
    if "safety_identifier" in payload:
        identifier = payload["safety_identifier"]
        if not isinstance(identifier, str) or not (1 <= len(identifier) <= 64):
            raise RelayValidationError("safety_identifier must contain 1-64 characters.")

    forwarded = {key: payload[key] for key in ALLOWED_RESPONSE_FIELDS if key in payload}
    forwarded["model"] = config.model
    forwarded["store"] = False
    return forwarded


def forward_response_payload(payload: dict[str, Any], config: RelayConfig) -> UpstreamResponse:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{config.provider_base_url}/responses",
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
                body=response.read(),
                content_type=response.headers.get_content_type(),
            )
    except urllib.error.HTTPError as exc:
        return UpstreamResponse(
            status_code=exc.code,
            body=exc.read(),
            content_type=exc.headers.get_content_type() if exc.headers else "application/json",
        )
