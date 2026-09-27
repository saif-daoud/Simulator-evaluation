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
gateway_port="${SHARED_GATEWAY_PORT:-8002}"
shared_domain="${SHARED_NGROK_DOMAIN:-}"

if [[ ! -x "$ngrok_bin" ]]; then
  echo "ngrok is not executable at $ngrok_bin" >&2
  exit 1
fi
if [[ -z "$shared_domain" ]]; then
  echo "SHARED_NGROK_DOMAIN is required." >&2
  exit 1
fi
if ! curl --fail --silent --show-error \
  "http://127.0.0.1:${gateway_port}/__simulator_gateway_health" >/dev/null; then
  echo "The shared gateway is not healthy on port ${gateway_port}. Start run_gateway.sh first." >&2
  exit 1
fi

shared_url="$shared_domain"
if [[ ! "$shared_url" =~ ^https?:// ]]; then
  shared_url="https://${shared_url}"
fi

echo "Starting the shared domain gateway. Do not enable ngrok endpoint pooling." >&2
echo "If ERR_NGROK_334 appears, stop the previous ngrok process for this domain first." >&2
exec "$ngrok_bin" http "http://127.0.0.1:${gateway_port}" --log=stdout --url "$shared_url"
