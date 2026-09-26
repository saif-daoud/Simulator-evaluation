#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$server_dir"

if [[ ! -f .env ]]; then
  echo "Missing $server_dir/.env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${RELAY_TOKEN:?RELAY_TOKEN is required in .env}"
: "${PROVIDER_MODEL:?PROVIDER_MODEL is required in .env}"

base_url="${1:-http://127.0.0.1:${RELAY_PORT:-8001}}"
if [[ ! "$base_url" =~ ^https?:// ]]; then
  base_url="https://${base_url}"
fi
base_url="${base_url%/}"

health_file="$(mktemp)"
payload_file="$(mktemp)"
response_file="$(mktemp)"
curl_config="$(mktemp)"
cleanup() {
  rm -f -- "$health_file" "$payload_file" "$response_file" "$curl_config"
}
trap cleanup EXIT
chmod 600 "$curl_config"
printf 'header = "Authorization: Bearer %s"\n' "$RELAY_TOKEN" > "$curl_config"

curl --fail --silent --show-error \
  -H "ngrok-skip-browser-warning: 1" \
  "$base_url/api/health" > "$health_file"

python - "$health_file" "$PROVIDER_MODEL" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
assert payload.get("status") == "ok", payload
assert payload.get("configured") is True, payload
assert payload.get("model") == sys.argv[2], payload
PY

python - "$PROVIDER_MODEL" > "$payload_file" <<'PY'
import json
import sys

print(json.dumps({
    "model": sys.argv[1],
    "instructions": "Return the requested JSON and no other text.",
    "input": "Return a successful smoke-test result.",
    "max_output_tokens": 64,
    "text": {
        "format": {
            "type": "json_schema",
            "name": "relay_smoke_test",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"value": {"type": "string", "enum": ["ok"]}},
                "required": ["value"],
                "additionalProperties": False,
            },
        }
    },
    "safety_identifier": "standalone-relay-smoke-test",
    "store": False,
}))
PY

curl --fail --silent --show-error \
  --config "$curl_config" \
  -H "Content-Type: application/json" \
  -H "ngrok-skip-browser-warning: 1" \
  --data-binary "@$payload_file" \
  "$base_url/api/responses" > "$response_file"

python - "$response_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
result = json.loads(payload["output_text"])
assert result == {"value": "ok"}, result
PY

echo "Relay smoke test passed through $base_url using $PROVIDER_MODEL."
