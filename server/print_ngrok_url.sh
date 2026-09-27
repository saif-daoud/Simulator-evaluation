#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$server_dir"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ngrok_web_addr="${NGROK_WEB_ADDR:-127.0.0.1:4041}"
relay_port="${RELAY_PORT:-8001}"

inspector_addresses=("$ngrok_web_addr")
for inspector_port in {4040..4050}; do
  candidate="127.0.0.1:${inspector_port}"
  if [[ "$candidate" != "$ngrok_web_addr" ]]; then
    inspector_addresses+=("$candidate")
  fi
done

for inspector_address in "${inspector_addresses[@]}"; do
  if ! tunnels_json="$(curl --fail --silent "http://${inspector_address}/api/tunnels" 2>/dev/null)"; then
    continue
  fi
  if public_url="$(NGROK_TUNNELS_JSON="$tunnels_json" RELAY_PORT="$relay_port" python - <<'PY'
import json
import os

payload = json.loads(os.environ["NGROK_TUNNELS_JSON"])
relay_port = os.environ["RELAY_PORT"]

for tunnel in payload.get("tunnels", []):
    config = tunnel.get("config") or {}
    upstreams = (
        config.get("addr", ""),
        tunnel.get("forwards_to", ""),
        tunnel.get("upstream_url", ""),
    )
    points_to_relay = any(
        value.rstrip("/").endswith(f":{relay_port}") for value in upstreams if isinstance(value, str)
    )
    public_url = tunnel.get("public_url", "")
    if points_to_relay and public_url.startswith("https://"):
        print(public_url)
        raise SystemExit(0)

raise SystemExit(1)
PY
  )"; then
    printf '%s\n' "$public_url"
    exit 0
  fi
done

if [[ -f logs/ngrok.log ]]; then
  public_url="$(grep -oE 'url=https://[^[:space:]]+' logs/ngrok.log | tail -n 1 | sed -E 's/^url=//; s/[\"]$//' || true)"
  if [[ -n "$public_url" ]]; then
    printf '%s\n' "$public_url"
    exit 0
  fi
fi

echo "No HTTPS ngrok tunnel forwarding to port ${relay_port} was found." >&2
echo "Check logs/ngrok.log and confirm the ngrok process is still running." >&2
exit 1
