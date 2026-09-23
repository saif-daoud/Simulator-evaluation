# CBT Simulator Evaluation

A separate expert-study website for evaluating three patient simulators:

- Patient-Ψ
- PatientAct
- TOPAS

The expert plays the therapist. Each selected case is evaluated in three sequential sessions, and every session is scored on the five PatientAct dimensions: coherence, disclosure, resistance, emotional expression, and realism.

## Architecture

```text
Static frontend (GitHub Pages or any static host)
       |
       v
Cloudflare Worker (authentication + study API + GPT-5.1 proxy)
       |
       +-- OpenAI Responses API (standalone Patient-Ψ, PatientAct, and TOPAS pipelines)
       +-- isolated SQLite-backed Durable Object (sessions, messages, ratings)
```

This project does not use or modify `interface/cbt-live-interaction` and does not connect to the QCRI inference server. The small Worker is required because an OpenAI API key must never be embedded in browser JavaScript.

The deployed website is self-contained. `worker/src/patient_psi.js` ports the cognitive-model builder and Patient-Ψ response generator. `worker/src/patient_act.js` ports PatientAct's topic extraction, disclosure-gated memory retrieval, reaction, behavior, resistance, response, and trust-update stages. `worker/src/topas.js` ports TOPAS's two-stage dynamic-state update and utterance-generation loop, while `worker/src/topas_data.js` embeds the extracted CBT profile schema and both prompt templates. The required prompts and selected case data are bundled under `worker/src`; the runtime does not import from `simulations/`.

## Local setup

For the fastest local preview, run the bundled Node server. It serves both the frontend and a persistent local study API:

```bash
cd worker
npm install
npm run dev:local
```

Open `http://127.0.0.1:8787` and use either `EXPERT-0001` / `LOCAL-EXPERT-0001` or `EXPERT-0002` / `LOCAL-EXPERT-0002`. Without an OpenAI or Azure OpenAI provider key, this command automatically uses mock patient responses and labels that mode in the header. To exercise the integrated simulators, copy `.dev.vars.example` to `.dev.vars`, configure a dedicated key and matching base URL, and keep `MOCK_OPENAI=false`.

To use the Cloudflare runtime locally instead:

1. Install the Worker tooling:

   ```bash
   cd worker
   npm install
   ```

2. Copy `worker/.dev.vars.example` to `worker/.dev.vars` and replace every placeholder. Use `MOCK_OPENAI=true` to exercise the full flow without making API calls. The SQLite-backed Durable Object creates its schema automatically.

3. Start the Worker:

   ```bash
   npm run dev
   ```

4. In a second terminal, serve the frontend from the project root:

   ```bash
   python -m http.server 5500 --directory frontend
   ```

5. Open `http://localhost:5500`.

The checked-in `frontend/config.js` points local hosts at `http://127.0.0.1:8787`. Set `apiBase` to the deployed Worker URL before publishing the frontend.

## Production setup

1. Set `AZURE_OPENAI_API_KEY`, `EXPERT_ACCESS_CODES`, and `TOKEN_SECRET` with `wrangler secret put`. `EXPERT_ACCESS_CODES` is a JSON object whose keys are participant codes and whose values are their distinct access codes.
2. Set `PARTICIPANT_CODES`, `PROFILE_ASSIGNMENTS`, `ALLOWED_ORIGINS`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` in `wrangler.toml`.
3. Deploy with `npm run deploy` from `worker/`. The isolated SQLite-backed Durable Object is created by the `v1` migration and initializes its own schema.
4. Put the deployed Worker URL in `frontend/config.js`, then publish `frontend/`.

The included GitHub Actions workflows test and deploy the Worker and publish `frontend/` to GitHub Pages when `main` is pushed. They use encrypted repository secrets for Cloudflare, Azure OpenAI, the per-expert access-code map, and token signing.

Use a restricted, expiring OpenAI project key and set project spend limits. Do not copy credentials from the existing live-interaction study.

## Study behavior

- The same case is used for all three simulator sessions, enabling within-case comparison.
- Expert 1 receives cases 1–20 and Expert 2 receives cases 21–40; API authorization prevents either expert from opening the other's cases.
- Simulator order is randomized server-side and only anonymous labels reach the browser.
- Only one session can be active at a time.
- The expert starts every conversation by sending the first message as the therapist.
- A session moves to evaluation after 50 therapist-patient turns, when the expert ends it, or when either speaker gives a direct bye/goodbye farewell.
- The expert proceeds to the next session only after all five ratings are submitted.
- Scores use a 1–5 anchored scale; comments are optional.
- TOPAS builds a populated case profile deterministically, updates all 14 categorical dynamic-state dimensions before each reply, and then generates the patient utterance in a separate GPT-5.1 request.

## Verification

```bash
cd worker
npm test
npm run test:e2e
npm run check
node --check ../frontend/app.js
```

`test:e2e` exercises the real Worker router and SQL schema with an in-memory D1-compatible SQLite adapter. It covers authentication and all three sequential sessions through rating submission. A headless Chrome smoke test was also used during development to verify the rendered login, case, chat, evaluation, and progression flow.

Before inviting experts, add supervisor-approved consent, withdrawal, retention, and research-contact language; those study-specific statements are intentionally not invented here.
