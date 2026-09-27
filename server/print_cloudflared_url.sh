#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$server_dir"

log_path="${CLOUDFLARED_LOG:-logs/cloudflared.log}"

for _ in {1..30}; do
  if [[ -f "$log_path" ]]; then
    public_url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_path" | tail -n 1 || true)"
    if [[ -n "$public_url" ]] && grep -q 'Registered tunnel connection' "$log_path"; then
      printf '%s\n' "$public_url"
      exit 0
    fi
  fi
  sleep 1
done

if [[ -n "${public_url:-}" ]]; then
  echo "Cloudflare assigned $public_url, but no tunnel connection was registered." >&2
  echo "Check whether outbound TCP or UDP port 7844 is blocked." >&2
  exit 1
fi

echo "No Cloudflare Quick Tunnel URL was found in $log_path." >&2
echo "Check the log and confirm that the cloudflared process is still running." >&2
exit 1
