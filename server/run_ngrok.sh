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

ngrok_bin="${NGROK_BIN:-$HOME/bin/ngrok}"
relay_port="${RELAY_PORT:-8001}"
relay_domain="${RELAY_NGROK_DOMAIN:-}"
ngrok_web_addr="${NGROK_WEB_ADDR:-127.0.0.1:4041}"

if [[ ! -x "$ngrok_bin" ]]; then
  echo "ngrok is not executable at $ngrok_bin" >&2
  exit 1
fi
if ! relay_health="$(curl --fail --silent --show-error "http://127.0.0.1:${relay_port}/api/health")"; then
  echo "The relay is not healthy on 127.0.0.1:${relay_port}. Start it before ngrok." >&2
  exit 1
fi
if ! RELAY_HEALTH_JSON="$relay_health" python - <<'PY'
import json
import os

payload = json.loads(os.environ["RELAY_HEALTH_JSON"])
raise SystemExit(0 if payload.get("configured") is True else 1)
PY
then
  echo "The relay is running but not configured. Set RELAY_TOKEN and PROVIDER_API_KEY, then restart it." >&2
  exit 1
fi

ngrok_args=(
  http "http://127.0.0.1:${relay_port}"
  --log=stdout
)

ngrok_http_help="$("$ngrok_bin" http --help 2>&1 || true)"
if grep -q -- '--web-addr' <<<"$ngrok_http_help"; then
  ngrok_args+=(--web-addr "$ngrok_web_addr")
else
  echo "This ngrok version has no --web-addr flag; ngrok will select its local inspector port." >&2
fi

if [[ -n "$relay_domain" ]]; then
  relay_url="$relay_domain"
  if [[ ! "$relay_url" =~ ^https?:// ]]; then
    relay_url="https://${relay_url}"
  fi
  ngrok_args+=(--url "$relay_url")
else
  echo "RELAY_NGROK_DOMAIN is blank; ngrok will assign a temporary public URL." >&2
  echo "Run 'bash print_ngrok_url.sh' after the tunnel starts to display it." >&2
fi

exec "$ngrok_bin" "${ngrok_args[@]}"
