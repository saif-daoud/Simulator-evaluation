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
  PARTICIPANT_CODES: "EXPERT-5136",
  PROFILE_ASSIGNMENTS: "EXPERT-5136:1-40",
  EXPERT_ACCESS_CODES: JSON.stringify({ "EXPERT-5136": "LOCAL-EXPERT-5136" }),
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

async function register(email) {
  const login = await call("/api/auth/login", { email, access_code: "LOCAL-EXPERT-5136" });
  assert.equal(login.email, email);
  assert.equal(login.profile_required, true);
  await call("/api/auth/profile", {
    name: "Dr Test Expert",
    role: "Clinical psychologist",
    institution: "Test Institute",
    latest_degree: "PhD",
    years_experience: 12
  }, login.token);
  const resumed = await call("/api/auth/login", { email, access_code: "LOCAL-EXPERT-5136" });
  assert.equal(resumed.profile_required, false);
  return resumed.token;
}

const rejectedOldCode = await requestApi("/api/auth/login", {
  email: "old-code@example.org",
  access_code: "LOCAL-EXPERT-8427"
});
assert.equal(rejectedOldCode.response.status, 403);

const firstToken = await register("first@example.org");
const secondToken = await register("second@example.org");

const firstOffer = await call("/api/bootstrap", {}, firstToken);
const secondOffer = await call("/api/bootstrap", {}, secondToken);
for (const offer of [firstOffer, secondOffer]) {
  assert.equal(offer.required_patients, 0);
  assert.equal(offer.next_patient_available, true);
  assert.deepEqual(offer.profiles.map(profile => profile.id), ["case-01"]);
  assert.deepEqual(offer.profiles.map(profile => profile.display_name), ["Patient 01"]);
}

// Merely opening a patient does not claim it; both experts can still see the same provisional offer.
let { study: firstStudy } = await call("/api/studies/start", { profile_id: "case-01" }, firstToken);
let { study: secondStudy } = await call("/api/studies/start", { profile_id: "case-01" }, secondToken);
assert.deepEqual(firstStudy.sessions.map(session => session.status), ["ready", "locked", "locked"]);
assert.equal(JSON.stringify(firstStudy).includes("simulator_key"), false);

// Starting the first session creates a temporary reservation.
({ study: firstStudy } = await call("/api/sessions/start", { session_id: firstStudy.sessions[0].id }, firstToken));
let assignment = await DB.prepare("SELECT status FROM patient_assignments WHERE profile_id = 'case-01'").first();
assert.equal(assignment.status, "reserved");

// A competing unstarted study is released and receives the next patient instead.
const collision = await requestApi("/api/sessions/start", { session_id: secondStudy.sessions[0].id }, secondToken);
assert.equal(collision.response.status, 409);
assert.match(collision.payload.error, /another expert/i);
const secondNext = await call("/api/bootstrap", {}, secondToken);
assert.deepEqual(secondNext.profiles.map(profile => profile.id), ["case-02"]);
assert.deepEqual(secondNext.profiles.map(profile => profile.display_name), ["Patient 01"]);
({ study: secondStudy } = await call("/api/studies/start", { profile_id: "case-02" }, secondToken));
({ study: secondStudy } = await call("/api/sessions/start", { session_id: secondStudy.sessions[0].id }, secondToken));

// A reservation with no completed session expires and returns its patient to the pool.
const thirdToken = await register("third@example.org");
const thirdOffer = await call("/api/bootstrap", {}, thirdToken);
assert.deepEqual(thirdOffer.profiles.map(profile => profile.id), ["case-03"]);
let { study: thirdStudy } = await call("/api/studies/start", { profile_id: "case-03" }, thirdToken);
({ study: thirdStudy } = await call("/api/sessions/start", { session_id: thirdStudy.sessions[0].id }, thirdToken));
await DB.prepare("UPDATE patient_assignments SET expires_at = ? WHERE study_id = ?")
  .bind("2000-01-01T00:00:00.000Z", thirdStudy.id).run();
const thirdAfterExpiry = await call("/api/bootstrap", {}, thirdToken);
assert.deepEqual(thirdAfterExpiry.profiles.map(profile => profile.id), ["case-03"]);
assert.equal(await DB.prepare("SELECT study_id FROM patient_assignments WHERE profile_id = 'case-03'").first(), null);

for (let index = 0; index < 3; index += 1) {
  const session = firstStudy.sessions[index];
  if (index > 0) {
    ({ study: firstStudy } = await call("/api/sessions/start", { session_id: session.id }, firstToken));
  }
  ({ study: firstStudy } = await call("/api/sessions/message", {
    session_id: session.id,
    content: index === 0
      ? "Thank you for speaking with me. Goodbye."
      : "Thank you for sharing that. What has felt most difficult recently?",
    client_message_id: `message-${index}`
  }, firstToken));
  if (firstStudy.sessions[index].status === "active") {
    ({ study: firstStudy } = await call("/api/sessions/end", { session_id: session.id }, firstToken));
  }
  assert.equal(firstStudy.sessions[index].status, "rating");
  assignment = await DB.prepare("SELECT status FROM patient_assignments WHERE profile_id = 'case-01'").first();
  assert.equal(assignment.status, "claimed");
  ({ study: firstStudy } = await call("/api/sessions/rate", {
    session_id: session.id,
    scores: { coherence: 4, disclosure: 4, resistance: 3, emotional: 4, realism: 4 },
    comments: "Integration test"
  }, firstToken));
  assignment = await DB.prepare("SELECT status FROM patient_assignments WHERE profile_id = 'case-01'").first();
  assert.equal(assignment.status, index === 2 ? "completed" : "claimed");
}

assert.equal(firstStudy.status, "completed");
assert.equal(firstStudy.completed_sessions, 3);

// The first expert may stop, or voluntarily continue with the next free patient.
// Case 02 is reserved by the second expert, so case 03 is offered as Patient 02.
const firstNext = await call("/api/bootstrap", {}, firstToken);
assert.equal(firstNext.required_patients, 0);
assert.deepEqual(firstNext.profiles.map(profile => profile.id), ["case-01", "case-03"]);
assert.deepEqual(firstNext.profiles.map(profile => profile.display_name), ["Patient 01", "Patient 02"]);

const activeSecond = await call("/api/bootstrap", {}, secondToken);
assert.equal(activeSecond.required_patients, 1);
assert.equal(activeSecond.next_patient_available, false);
assert.deepEqual(activeSecond.profiles.map(profile => profile.id), ["case-02"]);

// Exercise the 50-turn automatic termination on the second expert's reserved patient.
const cappedSession = secondStudy.sessions[0];
for (let turn = 1; turn <= 50; turn += 1) {
  ({ study: secondStudy } = await call("/api/sessions/message", {
    session_id: cappedSession.id,
    content: `This is therapist turn ${turn}. Please continue.`,
    client_message_id: `capped-message-${turn}`
  }, secondToken));
  assert.equal(secondStudy.sessions[0].status, turn === 50 ? "rating" : "active");
}
assert.equal(secondStudy.sessions[0].termination_reason, "max_turns");
assert.equal(secondStudy.sessions[0].messages.filter(message => message.role === "therapist").length, 50);

const ratings = await DB.prepare("SELECT COUNT(*) AS count FROM simulator_ratings").first();
assert.equal(Number(ratings.count), 3);
const methods = await DB.prepare("SELECT COUNT(DISTINCT simulator_key) AS count FROM simulator_sessions WHERE study_id = ?")
  .bind(firstStudy.id).first();
assert.equal(Number(methods.count), 3);

console.log("End-to-end sequential patient allocation flow passed.");
