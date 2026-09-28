# Standalone simulator-evaluation relay

This directory is the complete server package for the patient-simulator evaluation website. It has no imports, files,
processes, environment variables, database, or deployment dependency on any other website.

The service exposes only:

- `GET /api/health`
- `POST /api/responses` (authenticated server-to-server GPT-5.1 model relay)

Study authentication, transcripts, and ratings remain in the simulator website's Cloudflare Worker and Durable Object.

## Recommended: share the existing ngrok hostname safely

The standalone gateway lets both websites use `polka-evasive-pleat.ngrok-free.dev` without endpoint pooling and
without modifying the `cbt-live-interaction` project:

- Every normal path is forwarded unchanged to the existing website on `127.0.0.1:8000`.
- Only `/simulator-evaluation-relay/` is forwarded to this authenticated relay on `127.0.0.1:8001`.
- ngrok points to the gateway on `127.0.0.1:8002`.

Add these values to this server's `.env`:

```dotenv
SHARED_EXISTING_ORIGIN=http://127.0.0.1:8000
SHARED_RELAY_ORIGIN=http://127.0.0.1:8001
SHARED_GATEWAY_HOST=127.0.0.1
SHARED_GATEWAY_PORT=8002
SHARED_GATEWAY_TIMEOUT_SECONDS=600
SHARED_NGROK_DOMAIN=polka-evasive-pleat.ngrok-free.dev
```

Start both application servers first, then start and test the gateway without changing the live tunnel:

```bash
nohup bash run_gateway.sh > logs/gateway.log 2>&1 < /dev/null &
echo $! > logs/gateway.pid
disown
sleep 3

curl --fail http://127.0.0.1:8002/__simulator_gateway_health
curl --fail http://127.0.0.1:8002/api/health
curl --fail http://127.0.0.1:8002/simulator-evaluation-relay/api/health
```

The second response must be the existing website's health response; the third must be this relay with
`"configured":true` and `"model":"gpt-5.1"`.

There is a brief one-time interruption while replacing only the old ngrok process. Find that exact process with
`ps -ef | grep '[n]grok'`, stop its PID, and immediately start the shared tunnel:

```bash
nohup bash run_shared_ngrok.sh > logs/shared-ngrok.log 2>&1 < /dev/null &
echo $! > logs/shared-ngrok.pid
disown
sleep 5
tail -n 30 logs/shared-ngrok.log
```

Never use `--pooling-enabled`: pooling would distribute requests between unrelated upstreams instead of routing
them by path. Verify both public routes and make a small real model call:

```bash
curl --fail -H 'ngrok-skip-browser-warning: 1' \
  https://polka-evasive-pleat.ngrok-free.dev/api/health
curl --fail -H 'ngrok-skip-browser-warning: 1' \
  https://polka-evasive-pleat.ngrok-free.dev/simulator-evaluation-relay/api/health
bash smoke_test.sh \
  https://polka-evasive-pleat.ngrok-free.dev/simulator-evaluation-relay
```

Set the deployed Worker's secrets to:

```text
LLM_RELAY_BASE_URL=https://polka-evasive-pleat.ngrok-free.dev/simulator-evaluation-relay/api
LLM_RELAY_TOKEN=<the same RELAY_TOKEN stored in this server's .env>
```

To stop this arrangement without stopping either application server:

```bash
kill "$(cat logs/shared-ngrok.pid)" 2>/dev/null || true
kill "$(cat logs/gateway.pid)" 2>/dev/null || true
```

## Upload and run

Upload this entire `server/` directory as `~/simulator-evaluation-server/`, then run:

```bash
cd ~/simulator-evaluation-server
source ~/miniconda3/etc/profile.d/conda.sh
conda env create -f environment.yml
conda activate simulator-evaluation-api

cp .env.example .env     # Skip this when the prepared private .env was uploaded.
chmod 600 .env
# Edit .env and set RELAY_TOKEN, PROVIDER_API_KEY, PROVIDER_BASE_URL,
# RELAY_NGROK_DOMAIN is needed only when using ngrok.

mkdir -p logs
nohup bash run.sh > logs/api.log 2>&1 & echo $! > logs/api.pid
curl --fail http://127.0.0.1:8001/api/health

```

## Free independent tunnel

The existing ngrok account assigns `polka-evasive-pleat.ngrok-free.dev` when no URL is specified. Because that
endpoint is already online for another website, a second ngrok agent exits with `ERR_NGROK_334`. Do not enable
ngrok endpoint pooling: it would load-balance requests between two unrelated applications.

Use a Cloudflare Quick Tunnel to obtain an independent free URL without changing or stopping the other website.
Install `cloudflared` once (the following download is for an x86-64 Linux server):

```bash
mkdir -p "$HOME/bin"
curl --fail --location \
  --output "$HOME/bin/cloudflared" \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod 700 "$HOME/bin/cloudflared"
"$HOME/bin/cloudflared" version
```

Start the Quick Tunnel and print its URL:

```bash
nohup bash run_cloudflared.sh > logs/cloudflared.log 2>&1 & echo $! > logs/cloudflared.pid
bash print_cloudflared_url.sh
```

The URL has the form `https://random-words.trycloudflare.com` and changes whenever the tunnel is restarted.
Quick Tunnels are intended for testing and evaluation, have no uptime SLA, allow up to 200 concurrent in-flight
requests, and do not support Server-Sent Events. This relay does not use Server-Sent Events.

Cloudflare Tunnel requires outbound port 7844: UDP for QUIC or TCP for HTTP/2. `print_cloudflared_url.sh` reports
the URL only after `cloudflared` has registered a tunnel connection. If both transports are blocked, ask the
network administrator to allow outbound TCP port 7844 to Cloudflare Tunnel endpoints before continuing.

## Separate ngrok domain (optional)

Do not use `polka-evasive-pleat.ngrok-free.dev` here. If a separate ngrok domain is available later, copy its exact
hostname into `RELAY_NGROK_DOMAIN`, then run:

```bash
nohup bash run_ngrok.sh > logs/ngrok.log 2>&1 & echo $! > logs/ngrok.pid
sleep 3
bash print_ngrok_url.sh
```

Either `example.ngrok-free.dev` or `https://example.ngrok-free.dev` is accepted as a separate domain value.

The Cloudflare Worker's `LLM_RELAY_BASE_URL` must be the printed URL plus `/api`, for example
`https://random-words.trycloudflare.com/api`. Its `LLM_RELAY_TOKEN` must match `RELAY_TOKEN` in `.env`. After every
temporary-URL change, update this Worker secret and redeploy the Worker.

`PROVIDER_BASE_URL` is the upstream QCRI model endpoint, not the ngrok URL. The default matches
`new_simulations/`:

```text
https://qcri-sakina-02.services.ai.azure.com/api/projects/qcri-sakina-02/openai/v1/
```

The Worker sends its existing Responses-shaped payload to this relay. The relay validates and converts it to the
same `/chat/completions` request style used by `new_simulations/`, including conversion of JSON schemas to Chat
Completions `response_format`, and returns a Responses-compatible result to the Worker.

## End-to-end verification

After starting the API, test the complete local relay-to-QCRI model path (this makes one small model call):

```bash
bash smoke_test.sh
```

After starting the Cloudflare Quick Tunnel, test the same path through its public URL:

```bash
RELAY_PUBLIC_URL="$(bash print_cloudflared_url.sh)"
bash smoke_test.sh "$RELAY_PUBLIC_URL"
```

Both commands must finish with `Relay smoke test passed`. The script checks relay authentication, the configured
model, the upstream QCRI endpoint, structured output conversion, and response parsing without printing either API
credential.

To stop only this standalone server:

```bash
cd ~/simulator-evaluation-server
kill "$(cat logs/ngrok.pid)" 2>/dev/null || true
kill "$(cat logs/cloudflared.pid)" 2>/dev/null || true
kill "$(cat logs/api.pid)" 2>/dev/null || true
```
