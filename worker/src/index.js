import { PROFILES } from "./profiles.js";
import { generatePatientActResponse } from "./patient_act.js";
import { generatePatientPsiResponse } from "./patient_psi.js";
import { generateTopasResponse } from "./topas.js";

export const SIMULATOR_KEYS = ["patient_psi", "patient_act", "topas"];
export const MAX_THERAPIST_TURNS = 50;
const SIMULATOR_PLACEHOLDERS = SIMULATOR_KEYS.map(() => "?").join(", ");
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const PROFILE_BY_ID = new Map(PROFILES.map(profile => [profile.id, profile]));
const SPEAKER_PREFIX = /^\s*(?:(?:therapist|patient|client|persuader|persuadee)\s*:\s*)+/i;
const FAREWELL = /(?<![\w])(?:good(?:[\s-]+)?bye|bye(?:[\s-]+bye)?)(?![\w])/giu;

function responseJson(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function originAllowed(env, origin) {
  return !origin || allowedOrigins(env).includes(origin);
}

function corsHeaders(env, origin) {
  const allowed = allowedOrigins(env);
  const resolved = origin && allowed.includes(origin) ? origin : allowed[0] || "null";
  return {
    "Access-Control-Allow-Origin": resolved,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function base64UrlEncode(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

function byteEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function secureEqual(left, right) {
  return byteEqual(await digest(left), await digest(right));
}

async function makeToken(env, participantCode) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not configured");
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ participant_code: participantCode, exp: Date.now() + TOKEN_TTL_MS })));
  return `${payload}.${base64UrlEncode(await hmac(env.TOKEN_SECRET, payload))}`;
}

async function verifyToken(env, token) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not configured");
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw new Error("Invalid token");
  const expected = await hmac(env.TOKEN_SECRET, payload);
  if (!byteEqual(expected, base64UrlDecode(signature))) throw new Error("Invalid token");
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  if (!parsed.participant_code || Date.now() > Number(parsed.exp || 0)) throw new Error("Expired token");
  return parsed;
}

async function authenticatedParticipant(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("Missing authorization");
  const payload = await verifyToken(env, header.slice(7));
  return String(payload.participant_code);
}

export function sanitizeText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function farewellPhrase(value) {
  const cleaned = String(value ?? "").replace(SPEAKER_PREFIX, "").trim();
  for (const match of cleaned.matchAll(FAREWELL)) {
    const before = cleaned.slice(0, match.index);
    const after = cleaned.slice(match.index + match[0].length);
    if (/\b(?:say|says|said|saying|word|phrase)\W*$/iu.test(before)) continue;
    if (/^\W*to\b/iu.test(after)) continue;
    return match[0];
  }
  return null;
}

export function validateRatings(scores) {
  const keys = ["coherence", "disclosure", "resistance", "emotional", "realism"];
  const result = {};
  for (const key of keys) {
    const value = Number(scores?.[key]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${key} must be an integer from 1 to 5`);
    }
    result[key] = value;
  }
  return result;
}

export function publicProfile(profile) {
  return {
    id: profile.id,
    display_number: profile.display_number,
    display_name: profile.display_name,
    condition: profile.condition,
    short_description: profile.short_description,
    summary: profile.summary,
    current_context: profile.current_context,
    relevant_history: profile.relevant_history,
    coping_strategies: profile.coping_strategies
  };
}

export function publicSession(session, messages = []) {
  const status = session.status;
  let simulatorState = {};
  try {
    simulatorState = JSON.parse(session.state_json || "{}");
  } catch {
    simulatorState = {};
  }
  return {
    id: session.id,
    anonymous_label: session.anonymous_label,
    display_order: Number(session.display_order),
    status,
    messages,
    termination_reason: simulatorState.termination?.reason || null,
    can_start: status === "ready",
    can_send: status === "active",
    can_end: status === "active" && messages.some(message => message.role === "therapist")
  };
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const swap = random[0] % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function now() {
  return new Date().toISOString();
}

async function parseBody(request) {
  return request.json().catch(() => ({}));
}

function participantAllowed(env, participantCode) {
  const allowed = String(env.PARTICIPANT_CODES || "")
    .split(",")
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  return allowed.includes(participantCode.toUpperCase());
}

async function studyOwner(env, studyId, participantCode) {
  return env.DB.prepare("SELECT id, participant_code, profile_id, status, created_at, completed_at FROM studies WHERE id = ? AND participant_code = ?")
    .bind(studyId, participantCode)
    .first();
}

async function sessionOwner(env, sessionId, participantCode) {
  const session = await env.DB.prepare(
    `SELECT ss.*, s.participant_code, s.profile_id, s.status AS study_status
       FROM simulator_sessions ss
       JOIN studies s ON s.id = ss.study_id
      WHERE ss.id = ? AND s.participant_code = ?`
  ).bind(sessionId, participantCode).first();
  return session && SIMULATOR_KEYS.includes(session.simulator_key) ? session : null;
}

async function serializeStudy(env, studyRecord) {
  const profile = PROFILE_BY_ID.get(studyRecord.profile_id);
  if (!profile) throw new Error("Study profile is unavailable");
  const current = await env.DB.prepare(
    `SELECT id FROM simulator_sessions
      WHERE study_id = ? AND simulator_key IN (${SIMULATOR_PLACEHOLDERS})
        AND status IN ('ready', 'active', 'rating')
      LIMIT 1`
  ).bind(studyRecord.id, ...SIMULATOR_KEYS).first();
  if (!current) {
    const nextLocked = await env.DB.prepare(
      `SELECT id FROM simulator_sessions
        WHERE study_id = ? AND simulator_key IN (${SIMULATOR_PLACEHOLDERS}) AND status = 'locked'
        ORDER BY display_order LIMIT 1`
    ).bind(studyRecord.id, ...SIMULATOR_KEYS).first();
    if (nextLocked) {
      await env.DB.prepare("UPDATE simulator_sessions SET status = 'ready' WHERE id = ? AND status = 'locked'")
        .bind(nextLocked.id).run();
    }
  }
  const result = await env.DB.prepare(
    `SELECT id, anonymous_label, display_order, status, state_json FROM simulator_sessions
      WHERE study_id = ? AND simulator_key IN (${SIMULATOR_PLACEHOLDERS})
      ORDER BY display_order`
  ).bind(studyRecord.id, ...SIMULATOR_KEYS).all();
  const sessions = [];
  for (const [index, session] of (result.results || []).entries()) {
    const messagesResult = await env.DB.prepare(
      "SELECT id, role, content, created_at FROM session_messages WHERE session_id = ? ORDER BY id"
    ).bind(session.id).all();
    sessions.push(publicSession({
      ...session,
      anonymous_label: `Patient session ${String.fromCharCode(65 + index)}`,
      display_order: index + 1
    }, messagesResult.results || []));
  }
  const completedSessions = sessions.filter(session => session.status === "completed").length;
  return {
    id: studyRecord.id,
    status: studyRecord.status,
    profile: publicProfile(profile),
    completed_sessions: completedSessions,
    total_sessions: SIMULATOR_KEYS.length,
    sessions
  };
}

async function generatePatientResponse(env, simulatorKey, profile, messages, state, participantCode, opening = false) {
  if (simulatorKey === "topas") {
    const generated = await generateTopasResponse(env, profile.prompt_profile, messages, state, participantCode, opening);
    generated.content = sanitizeText(generated.content, 4000);
    return generated;
  }
  const latestTherapist = opening
    ? "Hello. What would you like to focus on today?"
    : [...messages].reverse().find(message => message.role === "therapist")?.content || "";
  if (!latestTherapist) throw new Error("A therapist message is required");
  const generated = simulatorKey === "patient_act"
    ? await generatePatientActResponse(env, profile.prompt_profile.patient_act_case, latestTherapist, state, participantCode)
    : simulatorKey === "patient_psi"
      ? await generatePatientPsiResponse(env, profile.prompt_profile, latestTherapist, state, participantCode)
      : null;
  if (!generated) throw new Error("Unknown live simulator");
  generated.content = sanitizeText(generated.content, 4000);
  if (!generated.content) throw new Error("The simulator returned an empty patient response");
  return generated;
}

async function listMessages(env, sessionId) {
  const result = await env.DB.prepare("SELECT id, role, content, created_at FROM session_messages WHERE session_id = ? ORDER BY id")
    .bind(sessionId)
    .all();
  return result.results || [];
}

async function handleLogin(request, env, headers) {
  const body = await parseBody(request);
  const participantCode = sanitizeText(body.participant_code, 64).toUpperCase();
  const accessCode = String(body.access_code || "");
  if (!participantCode || !accessCode) return responseJson({ error: "Enter both study codes." }, 400, headers);
  if (!participantAllowed(env, participantCode) || !env.STUDY_ACCESS_CODE || !(await secureEqual(accessCode, env.STUDY_ACCESS_CODE))) {
    return responseJson({ error: "The participant or access code is not valid." }, 403, headers);
  }
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO participants (participant_code, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(participant_code) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).bind(participantCode, timestamp, timestamp).run();
  return responseJson({ token: await makeToken(env, participantCode), participant_code: participantCode }, 200, headers);
}

async function handleBootstrap(env, participantCode, headers) {
  const result = await env.DB.prepare(
    `SELECT s.id, s.profile_id, s.status,
             SUM(CASE WHEN ss.status = 'completed' AND ss.simulator_key IN ('patient_psi', 'patient_act', 'topas') THEN 1 ELSE 0 END) AS completed_sessions
       FROM studies s
       LEFT JOIN simulator_sessions ss ON ss.study_id = s.id
      WHERE s.participant_code = ?
      GROUP BY s.id, s.profile_id, s.status
      ORDER BY s.created_at`
  ).bind(participantCode).all();
  return responseJson({
    profiles: PROFILES.map(publicProfile),
    studies: (result.results || []).map(row => ({ ...row, completed_sessions: Number(row.completed_sessions || 0) }))
  }, 200, headers);
}

async function handleStartStudy(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const profileId = sanitizeText(body.profile_id, 32);
  if (!PROFILE_BY_ID.has(profileId)) return responseJson({ error: "Unknown case." }, 404, headers);
  const existing = await env.DB.prepare("SELECT * FROM studies WHERE participant_code = ? AND profile_id = ?")
    .bind(participantCode, profileId)
    .first();
  if (existing) return responseJson({ study: await serializeStudy(env, existing) }, 200, headers);
  const otherActive = await env.DB.prepare("SELECT id FROM studies WHERE participant_code = ? AND status = 'active' LIMIT 1")
    .bind(participantCode)
    .first();
  if (otherActive) return responseJson({ error: "Finish the active case before starting another." }, 409, headers);

  const studyId = crypto.randomUUID();
  const timestamp = now();
  const methods = shuffled(SIMULATOR_KEYS);
  const statements = [
    env.DB.prepare("INSERT INTO studies (id, participant_code, profile_id, status, created_at) VALUES (?, ?, ?, 'active', ?)")
      .bind(studyId, participantCode, profileId, timestamp)
  ];
  methods.forEach((simulatorKey, index) => {
    statements.push(env.DB.prepare(
      `INSERT INTO simulator_sessions
       (id, study_id, simulator_key, anonymous_label, display_order, status, state_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), studyId, simulatorKey, `Patient session ${String.fromCharCode(65 + index)}`,
      index + 1, index === 0 ? "ready" : "locked", JSON.stringify({ turn: 0, trust: 2.5 }), timestamp
    ));
  });
  await env.DB.batch(statements);
  const study = await studyOwner(env, studyId, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 201, headers);
}

async function handleGetStudy(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const study = await studyOwner(env, sanitizeText(body.study_id, 64), participantCode);
  if (!study) return responseJson({ error: "Study not found." }, 404, headers);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleStartSession(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participantCode);
  if (!session) return responseJson({ error: "Session not found." }, 404, headers);
  if (session.status === "active") {
    const study = await studyOwner(env, session.study_id, participantCode);
    return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
  }
  if (session.status !== "ready") return responseJson({ error: "This session is not ready to start." }, 409, headers);
  const blocker = await env.DB.prepare(
    `SELECT id FROM simulator_sessions
      WHERE study_id = ? AND id != ? AND simulator_key IN (${SIMULATOR_PLACEHOLDERS})
        AND status IN ('active', 'rating') LIMIT 1`
  ).bind(session.study_id, session.id, ...SIMULATOR_KEYS).first();
  if (blocker) return responseJson({ error: "Complete the current session and rating first." }, 409, headers);
  const profile = PROFILE_BY_ID.get(session.profile_id);
  const state = JSON.parse(session.state_json || "{}");
  const generated = await generatePatientResponse(env, session.simulator_key, profile, [], state, participantCode, true);
  const timestamp = now();
  const patientFarewell = farewellPhrase(generated.content);
  const nextState = patientFarewell
    ? {
        ...generated.state,
        termination: {
          reason: "patient_farewell",
          speaker: "patient",
          phrase: patientFarewell,
          utterance: generated.content
        }
      }
    : generated.state;
  await env.DB.batch([
    patientFarewell
      ? env.DB.prepare("UPDATE simulator_sessions SET status = 'rating', state_json = ?, started_at = COALESCE(started_at, ?), ended_at = ? WHERE id = ? AND status = 'ready'")
        .bind(JSON.stringify(nextState), timestamp, timestamp, session.id)
      : env.DB.prepare("UPDATE simulator_sessions SET status = 'active', state_json = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'ready'")
        .bind(JSON.stringify(nextState), timestamp, session.id),
    env.DB.prepare("INSERT OR IGNORE INTO session_messages (session_id, role, content, client_message_id, created_at) VALUES (?, 'patient', ?, ?, ?)")
      .bind(session.id, generated.content, `opening:${session.id}`, timestamp)
  ]);
  const study = await studyOwner(env, session.study_id, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleMessage(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participantCode);
  if (!session) return responseJson({ error: "Session not found." }, 404, headers);
  if (session.status !== "active") return responseJson({ error: "This conversation is not active." }, 409, headers);
  const content = sanitizeText(body.content, 4000);
  const clientMessageId = sanitizeText(body.client_message_id, 80);
  if (!content || !clientMessageId) return responseJson({ error: "A message and request ID are required." }, 400, headers);
  const duplicate = await env.DB.prepare("SELECT id FROM session_messages WHERE session_id = ? AND client_message_id = ?")
    .bind(session.id, clientMessageId)
    .first();
  if (duplicate) {
    const study = await studyOwner(env, session.study_id, participantCode);
    return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
  }
  const history = await listMessages(env, session.id);
  const therapistTurn = history.filter(message => message.role === "therapist").length + 1;
  const therapistFarewell = farewellPhrase(content);
  if (therapistFarewell) {
    const timestamp = now();
    const nextState = {
      ...JSON.parse(session.state_json || "{}"),
      termination: {
        reason: "therapist_farewell",
        speaker: "therapist",
        phrase: therapistFarewell,
        utterance: content
      }
    };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO session_messages (session_id, role, content, client_message_id, created_at) VALUES (?, 'therapist', ?, ?, ?)")
        .bind(session.id, content, clientMessageId, timestamp),
      env.DB.prepare("UPDATE simulator_sessions SET state_json = ?, status = 'rating', ended_at = ? WHERE id = ? AND status = 'active'")
        .bind(JSON.stringify(nextState), timestamp, session.id)
    ]);
    const study = await studyOwner(env, session.study_id, participantCode);
    return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
  }
  const promptHistory = [...history, { role: "therapist", content }];
  const profile = PROFILE_BY_ID.get(session.profile_id);
  const generated = await generatePatientResponse(
    env, session.simulator_key, profile, promptHistory, JSON.parse(session.state_json || "{}"), participantCode, false
  );
  const timestamp = now();
  const patientFarewell = farewellPhrase(generated.content);
  const termination = patientFarewell
    ? {
        reason: "patient_farewell",
        speaker: "patient",
        phrase: patientFarewell,
        utterance: generated.content
      }
    : therapistTurn >= MAX_THERAPIST_TURNS
      ? { reason: "max_turns", speaker: null, limit: MAX_THERAPIST_TURNS }
      : null;
  const nextState = termination ? { ...generated.state, termination } : generated.state;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO session_messages (session_id, role, content, client_message_id, created_at) VALUES (?, 'therapist', ?, ?, ?)")
      .bind(session.id, content, clientMessageId, timestamp),
    env.DB.prepare("INSERT INTO session_messages (session_id, role, content, client_message_id, created_at) VALUES (?, 'patient', ?, ?, ?)")
      .bind(session.id, generated.content, `patient:${clientMessageId}`, timestamp),
    termination
      ? env.DB.prepare("UPDATE simulator_sessions SET state_json = ?, status = 'rating', ended_at = ? WHERE id = ? AND status = 'active'")
        .bind(JSON.stringify(nextState), timestamp, session.id)
      : env.DB.prepare("UPDATE simulator_sessions SET state_json = ? WHERE id = ?")
        .bind(JSON.stringify(nextState), session.id)
  ]);
  const study = await studyOwner(env, session.study_id, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleEndSession(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participantCode);
  if (!session) return responseJson({ error: "Session not found." }, 404, headers);
  if (["rating", "completed"].includes(session.status)) {
    const study = await studyOwner(env, session.study_id, participantCode);
    return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
  }
  if (session.status !== "active") return responseJson({ error: "This conversation is not active." }, 409, headers);
  const therapistMessage = await env.DB.prepare("SELECT id FROM session_messages WHERE session_id = ? AND role = 'therapist' LIMIT 1")
    .bind(session.id).first();
  if (!therapistMessage) return responseJson({ error: "Exchange at least one message before ending the session." }, 409, headers);
  const timestamp = now();
  const nextState = {
    ...JSON.parse(session.state_json || "{}"),
    termination: { reason: "expert_ended", speaker: "therapist" }
  };
  await env.DB.prepare("UPDATE simulator_sessions SET status = 'rating', state_json = ?, ended_at = ? WHERE id = ? AND status = 'active'")
    .bind(JSON.stringify(nextState), timestamp, session.id).run();
  const study = await studyOwner(env, session.study_id, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleRating(request, env, participantCode, headers) {
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participantCode);
  if (!session) return responseJson({ error: "Session not found." }, 404, headers);
  const existing = await env.DB.prepare("SELECT id FROM simulator_ratings WHERE session_id = ?").bind(session.id).first();
  if (existing) {
    const study = await studyOwner(env, session.study_id, participantCode);
    return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
  }
  if (session.status !== "rating") return responseJson({ error: "End the session before submitting its evaluation." }, 409, headers);
  let scores;
  try {
    scores = validateRatings(body.scores);
  } catch (error) {
    return responseJson({ error: error.message }, 400, headers);
  }
  const comments = sanitizeText(body.comments, 4000);
  const timestamp = now();
  const next = await env.DB.prepare(
    `SELECT id FROM simulator_sessions
      WHERE study_id = ? AND display_order > ? AND simulator_key IN (${SIMULATOR_PLACEHOLDERS})
      ORDER BY display_order LIMIT 1`
  ).bind(session.study_id, session.display_order, ...SIMULATOR_KEYS).first();
  const statements = [
    env.DB.prepare(
      `INSERT INTO simulator_ratings
       (id, session_id, participant_code, coherence, disclosure, resistance, emotional, realism, comments, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), session.id, participantCode, scores.coherence, scores.disclosure, scores.resistance, scores.emotional, scores.realism, comments, timestamp),
    env.DB.prepare("UPDATE simulator_sessions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'rating'")
      .bind(timestamp, session.id)
  ];
  if (next) {
    statements.push(env.DB.prepare("UPDATE simulator_sessions SET status = 'ready' WHERE id = ? AND status = 'locked'").bind(next.id));
  } else {
    statements.push(env.DB.prepare("UPDATE studies SET status = 'completed', completed_at = ? WHERE id = ?").bind(timestamp, session.study_id));
  }
  await env.DB.batch(statements);
  const study = await studyOwner(env, session.study_id, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function router(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(env, origin);
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: originAllowed(env, origin) ? headers : {} });
  }
  if (path === "/api/health" && request.method === "GET") {
    const mock = String(env.MOCK_OPENAI || "false").toLowerCase() === "true";
    return responseJson({
      ok: true,
      service: "cbt-simulator-evaluation",
      model: env.OPENAI_MODEL || "gpt-5.1",
      response_mode: mock ? "mock" : "openai",
      simulators: {
        patient_psi: mock ? "mock" : "integrated",
        patient_act: mock ? "mock" : "integrated",
        topas: mock ? "mock" : "integrated"
      }
    }, 200, headers);
  }
  if (!originAllowed(env, origin)) return responseJson({ error: "Origin not allowed." }, 403);
  if (request.method !== "POST") return responseJson({ error: "Method not allowed." }, 405, headers);
  if (path === "/api/auth/login") return handleLogin(request, env, headers);

  let participantCode;
  try {
    participantCode = await authenticatedParticipant(request, env);
  } catch {
    return responseJson({ error: "Your study session is not valid." }, 401, headers);
  }
  if (path === "/api/bootstrap") return handleBootstrap(env, participantCode, headers);
  if (path === "/api/studies/start") return handleStartStudy(request, env, participantCode, headers);
  if (path === "/api/study") return handleGetStudy(request, env, participantCode, headers);
  if (path === "/api/sessions/start") return handleStartSession(request, env, participantCode, headers);
  if (path === "/api/sessions/message") return handleMessage(request, env, participantCode, headers);
  if (path === "/api/sessions/end") return handleEndSession(request, env, participantCode, headers);
  if (path === "/api/sessions/rate") return handleRating(request, env, participantCode, headers);
  return responseJson({ error: "Not found." }, 404, headers);
}

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (error) {
      console.error("Unhandled study API error", error);
      const origin = request.headers.get("Origin") || "";
      return responseJson({ error: "The study API could not complete this request." }, 500, corsHeaders(env, origin));
    }
  }
};
