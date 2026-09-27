# Standalone simulator-evaluation relay

This directory is the complete server package for the patient-simulator evaluation website. It has no imports, files,
processes, environment variables, database, or deployment dependency on any other website.

The service exposes only:

- `GET /api/health`
- `POST /api/responses` (authenticated server-to-server GPT-4.1 model relay)

Study authentication, transcripts, and ratings remain in the simulator website's Cloudflare Worker and Durable Object.

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
# and leave RELAY_NGROK_DOMAIN blank for a free temporary URL.

mkdir -p logs
nohup bash run.sh > logs/api.log 2>&1 & echo $! > logs/api.pid
curl --fail http://127.0.0.1:8001/api/health

nohup bash run_ngrok.sh > logs/ngrok.log 2>&1 & echo $! > logs/ngrok.pid
sleep 3
bash print_ngrok_url.sh
```

With `RELAY_NGROK_DOMAIN=` left blank, ngrok assigns a free temporary URL. The URL printed by
`print_ngrok_url.sh` changes whenever this tunnel is restarted. The launcher requests
`NGROK_WEB_ADDR=127.0.0.1:4041` on ngrok versions that support the option. On older versions, ngrok selects an
available inspector port and `print_ngrok_url.sh` finds the tunnel by its port-8001 upstream.

Do not use `polka-evasive-pleat.ngrok-free.dev` here: that hostname belongs to the other website. Sharing it would
couple the two services and can send requests to the wrong server.

If a separate static domain is available later, copy its exact hostname into `RELAY_NGROK_DOMAIN` without a path.
Either `example.ngrok-free.dev` or `https://example.ngrok-free.dev` is accepted.

The Cloudflare Worker's `LLM_RELAY_BASE_URL` must be the printed URL plus `/api`, for example
`https://temporary-name.ngrok.app/api`. Its `LLM_RELAY_TOKEN` must match `RELAY_TOKEN` in `.env`. After every
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

After starting ngrok, test the same path through the public static domain:

```bash
RELAY_PUBLIC_URL="$(bash print_ngrok_url.sh)"
bash smoke_test.sh "$RELAY_PUBLIC_URL"
```

Both commands must finish with `Relay smoke test passed`. The script checks relay authentication, the configured
model, the upstream QCRI endpoint, structured output conversion, and response parsing without printing either API
credential.

To stop only this standalone server:

```bash
cd ~/simulator-evaluation-server
kill "$(cat logs/ngrok.pid)" 2>/dev/null || true
kill "$(cat logs/api.pid)" 2>/dev/null || true
```
