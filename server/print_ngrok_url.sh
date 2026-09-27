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
tunnels_json="$(curl --fail --silent --show-error "http://${ngrok_web_addr}/api/tunnels")"

NGROK_TUNNELS_JSON="$tunnels_json" python - <<'PY'
import json
import os
import sys

payload = json.loads(os.environ["NGROK_TUNNELS_JSON"])
urls = [
    tunnel.get("public_url", "")
    for tunnel in payload.get("tunnels", [])
    if tunnel.get("public_url", "").startswith("https://")
]
if not urls:
    print("No HTTPS ngrok tunnel was found.", file=sys.stderr)
    raise SystemExit(1)

print(urls[0])
PY
