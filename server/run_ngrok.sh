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

if [[ ! -x "$ngrok_bin" ]]; then
  echo "ngrok is not executable at $ngrok_bin" >&2
  exit 1
fi
if [[ -z "$relay_domain" ]]; then
  echo "RELAY_NGROK_DOMAIN is required." >&2
  exit 1
fi
relay_url="$relay_domain"
if [[ ! "$relay_url" =~ ^https?:// ]]; then
  relay_url="https://${relay_url}"
fi
if ! curl --fail --silent --show-error "http://127.0.0.1:${relay_port}/api/health" >/dev/null; then
  echo "The relay is not healthy on 127.0.0.1:${relay_port}. Start it before ngrok." >&2
  exit 1
fi

exec "$ngrok_bin" http "http://127.0.0.1:${relay_port}" --log=stdout --url "$relay_url"
