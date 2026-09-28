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

async function makeToken(env, participantCode, cohortCode) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not configured");
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    participant_code: participantCode,
    cohort_code: cohortCode,
    exp: Date.now() + TOKEN_TTL_MS
  })));
  return `${payload}.${base64UrlEncode(await hmac(env.TOKEN_SECRET, payload))}`;
}

async function verifyToken(env, token) {
  if (!env.TOKEN_SECRET) throw new Error("TOKEN_SECRET is not configured");
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw new Error("Invalid token");
  const expected = await hmac(env.TOKEN_SECRET, payload);
  if (!byteEqual(expected, base64UrlDecode(signature))) throw new Error("Invalid token");
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  if (!parsed.participant_code || !parsed.cohort_code || Date.now() > Number(parsed.exp || 0)) throw new Error("Expired token");
  return parsed;
}

async function authenticatedParticipant(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("Missing authorization");
  const payload = await verifyToken(env, header.slice(7));
  return {
    participant_code: String(payload.participant_code),
    cohort_code: String(payload.cohort_code).toUpperCase()
  };
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

function participantCodes(env) {
  return String(env.PARTICIPANT_CODES || "")
    .split(",")
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
}

function participantAllowed(env, participantCode) {
  return participantCodes(env).includes(participantCode.toUpperCase());
}

function normalizeEmail(value) {
  return sanitizeText(value, 254).toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicParticipant(participant) {
  return {
    email: participant.email,
    name: participant.name,
    role: participant.role,
    institution: participant.institution,
    latest_degree: participant.latest_degree,
    years_experience: Number(participant.years_experience)
  };
}

function validateParticipantProfile(value) {
  const profile = {
    name: sanitizeText(value?.name, 120),
    role: sanitizeText(value?.role, 160),
    institution: sanitizeText(value?.institution, 200),
    latest_degree: sanitizeText(value?.latest_degree, 160),
    years_experience: Number(value?.years_experience)
  };
  if (!profile.name || !profile.role || !profile.institution || !profile.latest_degree) {
    throw new Error("Complete every professional profile field.");
  }
  if (!Number.isInteger(profile.years_experience) || profile.years_experience < 0 || profile.years_experience > 80) {
    throw new Error("Years of clinical experience must be between 0 and 80.");
  }
  return profile;
}

async function participantCodeForEmail(email) {
  const bytes = await digest(email);
  return `P-${[...bytes].slice(0, 16).map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

function configuredAccessCodes(env) {
  const configured = String(env.EXPERT_ACCESS_CODES || "").trim();
  if (configured) {
    try {
      const codes = JSON.parse(configured);
      return codes && !Array.isArray(codes) && typeof codes === "object" ? codes : {};
    } catch {
      return {};
    }
  }
  const fallback = String(env.STUDY_ACCESS_CODE || "");
  return Object.fromEntries(participantCodes(env).map(code => [code, fallback]));
}

async function cohortForAccessCode(env, accessCode) {
  for (const [cohortCode, configuredCode] of Object.entries(configuredAccessCodes(env))) {
    if (participantAllowed(env, cohortCode) && configuredCode && await secureEqual(accessCode, String(configuredCode))) {
      return cohortCode.toUpperCase();
    }
  }
  return "";
}

function assignmentRange(env, cohortCode) {
  const configured = String(env.PROFILE_ASSIGNMENTS || "").trim();
  if (!configured) return { start: 1, end: PROFILES.length };
  const normalizedCohort = cohortCode.toUpperCase();
  const assignment = configured
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => value.match(/^([^:]+):(\d+)-(\d+)$/))
    .find(match => match?.[1].trim().toUpperCase() === normalizedCohort);
  if (!assignment) return null;
  const start = Number(assignment[2]);
  const end = Number(assignment[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function splitAssignmentCodes(env) {
  return String(env.SPLIT_PROFILE_ASSIGNMENTS || "")
    .split(",")
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
}

async function allocateAssignment(env, cohortCode) {
  const range = assignmentRange(env, cohortCode);
  if (!range) throw new Error("No patient assignment is configured for this access code.");
  if (!splitAssignmentCodes(env).includes(cohortCode)) {
    const existing = await env.DB.prepare(
      "SELECT participant_code FROM participants WHERE cohort_code = ? AND email IS NOT NULL AND email != '' LIMIT 1"
    ).bind(cohortCode).first();
    if (existing) throw new Error("This access code is already registered to an email address.");
    return range;
  }
  const assigned = await env.DB.prepare(
    `SELECT assignment_start FROM participants
      WHERE cohort_code = ? AND email IS NOT NULL AND email != ''
        AND assignment_start = assignment_end
        AND assignment_start BETWEEN ? AND ?`
  ).bind(cohortCode, range.start, range.end).all();
  const used = new Set((assigned.results || []).map(row => Number(row.assignment_start)));
  for (let profileNumber = range.start; profileNumber <= range.end; profileNumber += 1) {
    if (!used.has(profileNumber)) return { start: profileNumber, end: profileNumber };
  }
  throw new Error("All patient assignments for this access code have already been claimed.");
}

async function loadParticipant(env, participantCode) {
  return env.DB.prepare(
    `SELECT participant_code, email, cohort_code, assignment_start, assignment_end,
            name, role, institution, latest_degree, years_experience, profile_completed
       FROM participants WHERE participant_code = ?`
  ).bind(participantCode).first();
}

async function requireParticipant(request, env) {
  const identity = await authenticatedParticipant(request, env);
  if (!participantAllowed(env, identity.cohort_code)) throw new Error("Unknown cohort");
  const participant = await loadParticipant(env, identity.participant_code);
  if (!participant || participant.cohort_code !== identity.cohort_code || Number(participant.profile_completed) !== 1) {
    throw new Error("Unknown participant");
  }
  return participant;
}

export function assignedProfiles(env, participant) {
  const range = typeof participant === "string"
    ? assignmentRange(env, participant)
    : {
        start: Number(participant?.assignment_start),
        end: Number(participant?.assignment_end)
      };
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return [];
  return PROFILES.filter(profile => profile.display_number >= range.start && profile.display_number <= range.end);
}

function profileAssigned(env, participant, profileId) {
  return assignedProfiles(env, participant).some(profile => profile.id === profileId);
}

async function studyOwner(env, studyId, participantCode) {
  return env.DB.prepare("SELECT id, participant_code, profile_id, status, created_at, completed_at FROM studies WHERE id = ? AND participant_code = ?")
    .bind(studyId, participantCode)
    .first();
}

async function sessionOwner(env, sessionId, participant) {
  const session = await env.DB.prepare(
    `SELECT ss.*, s.participant_code, s.profile_id, s.status AS study_status
       FROM simulator_sessions ss
       JOIN studies s ON s.id = ss.study_id
      WHERE ss.id = ? AND s.participant_code = ?`
  ).bind(sessionId, participant.participant_code).first();
  return session
    && SIMULATOR_KEYS.includes(session.simulator_key)
    && profileAssigned(env, participant, session.profile_id)
    ? session
    : null;
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
    if (session.status === "active") {
      const legacyOpening = await env.DB.prepare(
        "SELECT id FROM session_messages WHERE session_id = ? AND client_message_id = ? LIMIT 1"
      ).bind(session.id, `opening:${session.id}`).first();
      const therapistMessage = await env.DB.prepare(
        "SELECT id FROM session_messages WHERE session_id = ? AND role = 'therapist' LIMIT 1"
      ).bind(session.id).first();
      if (legacyOpening && !therapistMessage) {
        const resetState = JSON.stringify({ turn: 0, trust: 2.5 });
        await env.DB.batch([
          env.DB.prepare("DELETE FROM session_messages WHERE session_id = ? AND client_message_id = ?")
            .bind(session.id, `opening:${session.id}`),
          env.DB.prepare("UPDATE simulator_sessions SET state_json = ? WHERE id = ?")
            .bind(resetState, session.id)
        ]);
        session.state_json = resetState;
      }
    }
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

async function generatePatientResponse(env, simulatorKey, profile, messages, state, participantCode) {
  if (simulatorKey === "topas") {
    const generated = await generateTopasResponse(env, profile.prompt_profile, messages, state, participantCode);
    generated.content = sanitizeText(generated.content, 4000);
    return generated;
  }
  const latestTherapist = [...messages].reverse().find(message => message.role === "therapist")?.content || "";
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
  const email = normalizeEmail(body.email);
  const accessCode = String(body.access_code || "");
  if (!validEmail(email) || !accessCode) return responseJson({ error: "Enter a valid email address and the study access code." }, 400, headers);
  const cohortCode = await cohortForAccessCode(env, accessCode);
  if (!cohortCode) return responseJson({ error: "The email or access code is not valid." }, 403, headers);
  const timestamp = now();
  let participant = await env.DB.prepare(
    `SELECT participant_code, email, cohort_code, assignment_start, assignment_end,
            name, role, institution, latest_degree, years_experience, profile_completed
       FROM participants WHERE lower(email) = ?`
  ).bind(email).first();
  if (participant && participant.cohort_code !== cohortCode) {
    return responseJson({ error: "This email is registered with a different study access code." }, 403, headers);
  }
  if (!participant) {
    let allocation;
    try {
      allocation = await allocateAssignment(env, cohortCode);
    } catch (error) {
      return responseJson({ error: error.message }, 409, headers);
    }
    const participantCode = await participantCodeForEmail(email);
    await env.DB.prepare(
      `INSERT INTO participants
       (participant_code, email, cohort_code, assignment_start, assignment_end, profile_completed, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(participantCode, email, cohortCode, allocation.start, allocation.end, timestamp, timestamp).run();
    participant = {
      participant_code: participantCode,
      email,
      cohort_code: cohortCode,
      assignment_start: allocation.start,
      assignment_end: allocation.end,
      profile_completed: 0
    };
  } else {
    await env.DB.prepare("UPDATE participants SET last_seen_at = ? WHERE participant_code = ?")
      .bind(timestamp, participant.participant_code).run();
  }
  return responseJson({
    token: await makeToken(env, participant.participant_code, cohortCode),
    email,
    profile_required: Number(participant.profile_completed) !== 1,
    profile: Number(participant.profile_completed) === 1 ? publicParticipant(participant) : null
  }, 200, headers);
}

async function handleParticipantProfile(request, env, participant, headers) {
  const body = await parseBody(request);
  let profile;
  try {
    profile = validateParticipantProfile(body);
  } catch (error) {
    return responseJson({ error: error.message }, 400, headers);
  }
  await env.DB.prepare(
    `UPDATE participants
        SET name = ?, role = ?, institution = ?, latest_degree = ?, years_experience = ?,
            profile_completed = 1, last_seen_at = ?
      WHERE participant_code = ? AND cohort_code = ?`
  ).bind(
    profile.name, profile.role, profile.institution, profile.latest_degree, profile.years_experience, now(),
    participant.participant_code, participant.cohort_code
  ).run();
  return responseJson({ saved: true, profile: { email: participant.email, ...profile } }, 200, headers);
}

async function handleBootstrap(env, participant, headers) {
  const result = await env.DB.prepare(
    `SELECT s.id, s.profile_id, s.status,
             SUM(CASE WHEN ss.status = 'completed' AND ss.simulator_key IN ('patient_psi', 'patient_act', 'topas') THEN 1 ELSE 0 END) AS completed_sessions
       FROM studies s
       LEFT JOIN simulator_sessions ss ON ss.study_id = s.id
      WHERE s.participant_code = ?
      GROUP BY s.id, s.profile_id, s.status
      ORDER BY s.created_at`
  ).bind(participant.participant_code).all();
  const profiles = assignedProfiles(env, participant);
  const assignedIds = new Set(profiles.map(profile => profile.id));
  return responseJson({
    profiles: profiles.map(publicProfile),
    studies: (result.results || [])
      .filter(row => assignedIds.has(row.profile_id))
      .map(row => ({ ...row, completed_sessions: Number(row.completed_sessions || 0) })),
    participant: publicParticipant(participant),
    required_patients: profiles.length
  }, 200, headers);
}

async function handleStartStudy(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const profileId = sanitizeText(body.profile_id, 32);
  if (!PROFILE_BY_ID.has(profileId)) return responseJson({ error: "Unknown case." }, 404, headers);
  if (!profileAssigned(env, participant, profileId)) return responseJson({ error: "This case is not assigned to this expert." }, 403, headers);
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

async function handleGetStudy(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const study = await studyOwner(env, sanitizeText(body.study_id, 64), participantCode);
  if (!study) return responseJson({ error: "Study not found." }, 404, headers);
  if (!profileAssigned(env, participant, study.profile_id)) return responseJson({ error: "Study not found." }, 404, headers);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleStartSession(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participant);
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
  const timestamp = now();
  await env.DB.prepare("UPDATE simulator_sessions SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'ready'")
    .bind(timestamp, session.id)
    .run();
  const study = await studyOwner(env, session.study_id, participantCode);
  return responseJson({ study: await serializeStudy(env, study) }, 200, headers);
}

async function handleMessage(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participant);
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

async function handleEndSession(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participant);
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

async function handleRating(request, env, participant, headers) {
  const participantCode = participant.participant_code;
  const body = await parseBody(request);
  const session = await sessionOwner(env, sanitizeText(body.session_id, 64), participant);
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
      response_mode: mock ? "mock" : (env.LLM_RELAY_BASE_URL ? "qcri-relay" : "openai"),
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

  let authentication;
  try {
    authentication = await authenticatedParticipant(request, env);
  } catch {
    return responseJson({ error: "Your study session is not valid." }, 401, headers);
  }
  if (!participantAllowed(env, authentication.cohort_code)) {
    return responseJson({ error: "Your study session is not valid." }, 401, headers);
  }
  const participant = await env.DB.prepare(
    `SELECT participant_code, email, cohort_code, assignment_start, assignment_end,
            name, role, institution, latest_degree, years_experience, profile_completed
       FROM participants WHERE participant_code = ?`
  ).bind(authentication.participant_code).first();
  if (!participant || participant.cohort_code !== authentication.cohort_code) {
    return responseJson({ error: "Your study session is not valid." }, 401, headers);
  }
  if (path === "/api/auth/profile") return handleParticipantProfile(request, env, participant, headers);
  if (Number(participant.profile_completed) !== 1) {
    return responseJson({ error: "Complete your participant details before beginning the study." }, 409, headers);
  }
  if (path === "/api/bootstrap") return handleBootstrap(env, participant, headers);
  if (path === "/api/studies/start") return handleStartStudy(request, env, participant, headers);
  if (path === "/api/study") return handleGetStudy(request, env, participant, headers);
  if (path === "/api/sessions/start") return handleStartSession(request, env, participant, headers);
  if (path === "/api/sessions/message") return handleMessage(request, env, participant, headers);
  if (path === "/api/sessions/end") return handleEndSession(request, env, participant, headers);
  if (path === "/api/sessions/rate") return handleRating(request, env, participant, headers);
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
