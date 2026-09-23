import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, "..");

class D1StatementShim {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1StatementShim(this.database, this.sql, bindings);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1DatabaseShim {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  exec(sql) {
    this.database.exec(sql);
  }

  prepare(sql) {
    return new D1StatementShim(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const DB = new D1DatabaseShim();
DB.exec(fs.readFileSync(path.join(workerRoot, "schema.sql"), "utf8"));

const env = {
  DB,
  ALLOWED_ORIGINS: "http://127.0.0.1:5500",
  PARTICIPANT_CODES: "EXPERT-01,EXPERT-02",
  PROFILE_ASSIGNMENTS: "EXPERT-01:1-20,EXPERT-02:21-40",
  EXPERT_ACCESS_CODES: JSON.stringify({
    "EXPERT-01": "LOCAL-EXPERT-01",
    "EXPERT-02": "LOCAL-EXPERT-02"
  }),
  OPENAI_MODEL: "gpt-5.1",
  OPENAI_API_KEY: "unused-in-mock-mode",
  MOCK_OPENAI: "true",
  TOKEN_SECRET: "integration-test-secret"
};
const origin = "http://127.0.0.1:5500";

async function requestApi(pathname, body, token = "") {
  const request = new Request(`http://local.test${pathname}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  const response = await worker.fetch(request, env);
  const payload = await response.json();
  return { response, payload };
}

async function call(pathname, body, token = "") {
  const { response, payload } = await requestApi(pathname, body, token);
  assert.ok(response.ok, `${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

const login = await call("/api/auth/login", { participant_code: "EXPERT-01", access_code: "LOCAL-EXPERT-01" });
const token = login.token;
const bootstrap = await call("/api/bootstrap", {}, token);
assert.equal(bootstrap.profiles.length, 20);
assert.deepEqual(bootstrap.profiles.map(profile => profile.id), Array.from({ length: 20 }, (_, index) => `case-${String(index + 1).padStart(2, "0")}`));
assert.equal(JSON.stringify(bootstrap).includes("simulator_key"), false);

const secondLogin = await call("/api/auth/login", { participant_code: "EXPERT-02", access_code: "LOCAL-EXPERT-02" });
const secondBootstrap = await call("/api/bootstrap", {}, secondLogin.token);
assert.equal(secondBootstrap.profiles.length, 20);
assert.deepEqual(secondBootstrap.profiles.map(profile => profile.id), Array.from({ length: 20 }, (_, index) => `case-${String(index + 21).padStart(2, "0")}`));
assert.equal(bootstrap.profiles.some(profile => secondBootstrap.profiles.some(other => other.id === profile.id)), false);

const crossedCode = await requestApi("/api/auth/login", { participant_code: "EXPERT-01", access_code: "LOCAL-EXPERT-02" });
assert.equal(crossedCode.response.status, 403);
const crossedCase = await requestApi("/api/studies/start", { profile_id: "case-21" }, token);
assert.equal(crossedCase.response.status, 403);
const ownCase = await call("/api/studies/start", { profile_id: "case-21" }, secondLogin.token);
assert.equal(ownCase.study.profile.id, "case-21");

let { study } = await call("/api/studies/start", { profile_id: "case-01" }, token);
assert.equal(study.sessions.length, 3);
assert.deepEqual(study.sessions.map(session => session.status), ["ready", "locked", "locked"]);
assert.equal(JSON.stringify(study).includes("patient_act"), false);
assert.equal(JSON.stringify(study).includes("patient_psi"), false);
assert.equal(JSON.stringify(study).includes("topas"), false);

for (let index = 0; index < 3; index += 1) {
  const session = study.sessions[index];
  ({ study } = await call("/api/sessions/start", { session_id: session.id, client_request_id: `start-${index}` }, token));
  assert.equal(study.sessions[index].status, "active");
  assert.equal(study.sessions[index].messages.length, 0);
  assert.equal(study.sessions[index].can_end, false);
  if (index === 0) {
    await DB.prepare(
      "INSERT INTO session_messages (session_id, role, content, client_message_id, created_at) VALUES (?, 'patient', ?, ?, ?)"
    ).bind(session.id, "Legacy generated opener", `opening:${session.id}`, new Date().toISOString()).run();
    await DB.prepare("UPDATE simulator_sessions SET state_json = ? WHERE id = ?")
      .bind(JSON.stringify({ turn: 1, legacy: true }), session.id).run();
    ({ study } = await call("/api/study", { study_id: study.id }, token));
    assert.equal(study.sessions[index].messages.length, 0);
  }
  ({ study } = await call("/api/sessions/message", {
    session_id: session.id,
    content: index === 0
      ? "Thank you for speaking with me. Goodbye."
      : "Thank you for sharing that. Could you tell me what feels most difficult about it right now?",
    client_message_id: `message-${index}`
  }, token));
  if (index === 0) {
    assert.deepEqual(study.sessions[index].messages.map(message => message.role), ["therapist"]);
    assert.equal(study.sessions[index].termination_reason, "therapist_farewell");
  } else {
    assert.deepEqual(study.sessions[index].messages.map(message => message.role), ["therapist", "patient"]);
    ({ study } = await call("/api/sessions/end", { session_id: session.id }, token));
    assert.equal(study.sessions[index].termination_reason, "expert_ended");
  }
  assert.equal(study.sessions[index].status, "rating");
  ({ study } = await call("/api/sessions/rate", {
    session_id: session.id,
    scores: { coherence: 4, disclosure: 4, resistance: 3, emotional: 4, realism: 4 },
    comments: "Integration test"
  }, token));
}

assert.equal(study.status, "completed");
assert.equal(study.completed_sessions, 3);
const ratings = await DB.prepare("SELECT COUNT(*) AS count FROM simulator_ratings").first();
assert.equal(Number(ratings.count), 3);
const methods = await DB.prepare("SELECT COUNT(DISTINCT simulator_key) AS count FROM simulator_sessions").first();
assert.equal(Number(methods.count), 3);

({ study } = await call("/api/studies/start", { profile_id: "case-02" }, token));
const cappedSession = study.sessions[0];
({ study } = await call("/api/sessions/start", { session_id: cappedSession.id, client_request_id: "start-capped" }, token));
assert.equal(study.sessions[0].messages.length, 0);
for (let turn = 1; turn <= 50; turn += 1) {
  ({ study } = await call("/api/sessions/message", {
    session_id: cappedSession.id,
    content: `This is therapist turn ${turn}. Please continue.`,
    client_message_id: `capped-message-${turn}`
  }, token));
  assert.equal(study.sessions[0].status, turn === 50 ? "rating" : "active");
}
assert.equal(study.sessions[0].termination_reason, "max_turns");
assert.equal(study.sessions[0].messages.filter(message => message.role === "therapist").length, 50);
console.log("End-to-end mocked study flow passed.");
