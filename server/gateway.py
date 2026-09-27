from __future__ import annotations

import asyncio
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response


RELAY_PREFIX = "/simulator-evaluation-relay"
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


@dataclass(frozen=True)
class GatewayConfig:
    existing_origin: str
    relay_origin: str
    timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "GatewayConfig":
        return cls(
            existing_origin=os.getenv("SHARED_EXISTING_ORIGIN", "http://127.0.0.1:8000").rstrip("/"),
            relay_origin=os.getenv("SHARED_RELAY_ORIGIN", "http://127.0.0.1:8001").rstrip("/"),
            timeout_seconds=float(os.getenv("SHARED_GATEWAY_TIMEOUT_SECONDS", "600")),
        )


CONFIG = GatewayConfig.from_environment()
app = FastAPI(
    title="Shared CBT study gateway",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def route_target(path: str, query: str, config: GatewayConfig = CONFIG) -> str:
    if path == RELAY_PREFIX or path.startswith(f"{RELAY_PREFIX}/"):
        origin = config.relay_origin
        upstream_path = path[len(RELAY_PREFIX) :] or "/"
    else:
        origin = config.existing_origin
        upstream_path = path
    target = f"{origin}{upstream_path}"
    return f"{target}?{query}" if query else target


def _forward(
    method: str,
    target: str,
    headers: dict[str, str],
    body: bytes,
    timeout_seconds: float,
) -> tuple[int, list[tuple[str, str]], bytes]:
    request = urllib.request.Request(
        target,
        data=body if body else None,
        headers=headers,
        method=method,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        response = opener.open(request, timeout=timeout_seconds)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, list(response.headers.items()), response.read()


@app.get("/__simulator_gateway_health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "cbt-shared-ngrok-gateway",
        "relay_prefix": RELAY_PREFIX,
    }


@app.api_route(
    "/{path:path}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(path: str, request: Request) -> Response:
    request_path = f"/{path}"
    target = route_target(request_path, request.url.query)
    request_headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() not in HOP_BY_HOP_HEADERS | {"host", "content-length"}
    }
    request_headers["X-Forwarded-Host"] = request.headers.get("host", "")
    request_headers["X-Forwarded-Proto"] = request.headers.get("x-forwarded-proto", request.url.scheme)
    body = await request.body()
    try:
        status, response_headers, content = await asyncio.to_thread(
            _forward,
            request.method,
            target,
            request_headers,
            body,
            CONFIG.timeout_seconds,
        )
    except (urllib.error.URLError, TimeoutError):
        return JSONResponse(
            {"error": {"message": "The selected gateway upstream is unavailable."}},
            status_code=502,
        )

    response = Response(content=content, status_code=status)
    for name, value in response_headers:
        if name.lower() not in HOP_BY_HOP_HEADERS | {"content-length"}:
            response.headers.append(name, value)
    return response
