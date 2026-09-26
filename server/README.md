# Standalone simulator-evaluation relay

This directory is the complete server package for the patient-simulator evaluation website. It has no imports, files,
processes, environment variables, database, or deployment dependency on any other website.

The service exposes only:

- `GET /api/health`
- `POST /api/responses` (authenticated server-to-server GPT-4.1 Responses relay)

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
# and a separate RELAY_NGROK_DOMAIN.

mkdir -p logs
nohup bash run.sh > logs/api.log 2>&1 & echo $! > logs/api.pid
curl --fail http://127.0.0.1:8001/api/health

nohup bash run_ngrok.sh > logs/ngrok.log 2>&1 & echo $! > logs/ngrok.pid
sleep 3
tail -n 30 logs/ngrok.log
```

The Cloudflare Worker's `LLM_RELAY_BASE_URL` must be `https://<relay-domain>/api`, and its `LLM_RELAY_TOKEN` must
match `RELAY_TOKEN` in `.env`.

`PROVIDER_BASE_URL` is the upstream QCRI model endpoint, not the ngrok URL. The default matches
`new_simulations/`:

```text
https://qcri-sakina-02.services.ai.azure.com/api/projects/qcri-sakina-02/openai/v1/
```

The relay removes a trailing slash before appending `/responses`.

To stop only this standalone server:

```bash
cd ~/simulator-evaluation-server
kill "$(cat logs/ngrok.pid)" 2>/dev/null || true
kill "$(cat logs/api.pid)" 2>/dev/null || true
```
