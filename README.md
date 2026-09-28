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
Cloudflare Worker (authentication + study API + simulator orchestration)
       |
       +-- authenticated server-to-server relay on the QCRI API
       |        |
       |        +-- GPT-5.1 Responses API from the permitted QCRI network
       +-- isolated SQLite-backed Durable Object (sessions, messages, ratings)
```

The Worker sends only model requests to the authenticated relay bundled in this repository's standalone `server/` directory; study state remains isolated in its Durable Object. The relay runs in its own Conda environment, on its own localhost port, and through its own ngrok domain. The provider key stays on the QCRI server and is never sent to the browser or stored in Cloudflare.

The deployed website is self-contained. `worker/src/patient_psi.js` ports the cognitive-model builder and Patient-Ψ response generator. `worker/src/patient_act.js` ports PatientAct's topic extraction, disclosure-gated memory retrieval, reaction, behavior, resistance, response, and trust-update stages. `worker/src/topas.js` ports TOPAS's two-stage dynamic-state update and utterance-generation loop, while `worker/src/topas_data.js` embeds the extracted CBT profile schema and both prompt templates. The required prompts and selected case data are bundled under `worker/src`; the runtime does not import from `simulations/`.

## Local setup

For the fastest local preview, run the bundled Node server. It serves both the frontend and a persistent local study API:

```bash
cd worker
npm install
npm run dev:local
```

Open `http://127.0.0.1:8787`, enter an email address, and use either `LOCAL-EXPERT-5136` (shared referral cohort) or `LOCAL-EXPERT-8427` (the 10-case expert). Each new email in the shared cohort receives one unique patient from cases 1–20; the second code assigns cases 21–30 to one expert. Without a relay or provider credential, this command automatically uses mock patient responses and labels that mode in the header. To exercise the integrated simulators, copy `.dev.vars.example` to `.dev.vars`, configure the relay token, and keep `MOCK_OPENAI=false`.

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

1. Upload the complete `server/` directory to the QCRI server and follow [`server/README.md`](server/README.md). It does not depend on another website or server project.
2. Set `LLM_RELAY_BASE_URL`, `LLM_RELAY_TOKEN`, `EXPERT_ACCESS_CODES`, and `TOKEN_SECRET` with `wrangler secret put`. With the shared-domain gateway, the relay URL is `https://polka-evasive-pleat.ngrok-free.dev/simulator-evaluation-relay/api`. `LLM_RELAY_TOKEN` must match the standalone server's `RELAY_TOKEN`. `EXPERT_ACCESS_CODES` maps cohort identifiers to access codes; a cohort code may be reused by multiple experts because each expert's identity and progress are stored under their normalized email address.
3. Set `PARTICIPANT_CODES`, `PROFILE_ASSIGNMENTS`, `SPLIT_PROFILE_ASSIGNMENTS`, `ALLOWED_ORIGINS`, and `OPENAI_MODEL` in `wrangler.toml`.
4. Deploy with `npm run deploy` from `worker/`. The isolated SQLite-backed Durable Object is created by the `v1` migration and initializes its own schema.
5. Put the deployed Worker URL in `frontend/config.js`, then publish `frontend/`.

The included GitHub Actions workflows test and deploy the Worker and publish `frontend/` to GitHub Pages when `main` is pushed. They use encrypted repository secrets for Cloudflare, the relay token, the per-expert access-code map, and token signing.

The QCRI API relay calls the same project endpoint and `/chat/completions` route configured in `new_simulations/`. It allowlists and converts the Worker's GPT-5.1 requests, never forwards a storage request, limits request/output sizes, and authenticates the Worker with a separate random bearer token.

## Study behavior

- The same case is used for all three simulator sessions, enabling within-case comparison.
- Participants sign in with an email address and cohort access code. On first login they provide their full name, role or specialty, institution, latest degree, and years of clinical experience; returning participants skip this form.
- The first cohort shares one access code. Each new email receives one unclaimed patient from cases 1–20, and its progress remains isolated under that email.
- The second access code is restricted to one email and receives all ten cases 21–30.
- Existing Durable Object studies, transcripts, and ratings are retained when participant-profile columns are added.
- Simulator order is randomized server-side and only anonymous labels reach the browser.
- Only one session can be active at a time.
- The expert starts every conversation by sending the first message as the therapist.
- A session moves to evaluation after 50 therapist-patient turns, when the expert ends it, or when either speaker gives a direct bye/goodbye farewell.
- The expert proceeds to the next session only after all five ratings are submitted.
- Signing out during an incomplete patient displays a reminder that all three simulator baselines and ratings must be finished. Browser navigation also triggers the browser's unsaved-work warning; messages and ratings already submitted remain stored.
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
