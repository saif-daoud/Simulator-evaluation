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

existing_origin="${SHARED_EXISTING_ORIGIN:-http://127.0.0.1:8000}"
relay_origin="${SHARED_RELAY_ORIGIN:-http://127.0.0.1:8001}"

if ! curl --fail --silent --show-error "${existing_origin%/}/api/health" >/dev/null; then
  echo "The existing CBT website is not healthy at ${existing_origin}." >&2
  exit 1
fi
if ! relay_health="$(curl --fail --silent --show-error "${relay_origin%/}/api/health")"; then
  echo "The simulator relay is not healthy at ${relay_origin}." >&2
  exit 1
fi
if ! RELAY_HEALTH_JSON="$relay_health" python - <<'PY'
import json
import os

payload = json.loads(os.environ["RELAY_HEALTH_JSON"])
raise SystemExit(0 if payload.get("configured") is True else 1)
PY
then
  echo "The simulator relay is running but is not configured." >&2
  exit 1
fi

exec python -m uvicorn gateway:app \
  --host "${SHARED_GATEWAY_HOST:-127.0.0.1}" \
  --port "${SHARED_GATEWAY_PORT:-8002}"
