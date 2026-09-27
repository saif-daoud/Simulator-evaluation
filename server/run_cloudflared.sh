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

cloudflared_bin="${CLOUDFLARED_BIN:-$HOME/bin/cloudflared}"
relay_port="${RELAY_PORT:-8001}"

if [[ ! -x "$cloudflared_bin" ]]; then
  echo "cloudflared is not executable at $cloudflared_bin" >&2
  exit 1
fi
if ! relay_health="$(curl --fail --silent --show-error "http://127.0.0.1:${relay_port}/api/health")"; then
  echo "The relay is not healthy on 127.0.0.1:${relay_port}. Start it before cloudflared." >&2
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

echo "Starting an independent Cloudflare Quick Tunnel for relay port ${relay_port}." >&2
echo "Run 'bash print_cloudflared_url.sh' after the tunnel starts to display it." >&2
exec "$cloudflared_bin" tunnel \
  --config "$server_dir/cloudflared-quick.yml" \
  --no-autoupdate \
  --url "http://127.0.0.1:${relay_port}"
