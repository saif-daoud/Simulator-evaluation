import test from "node:test";
import assert from "node:assert/strict";

import {
  assignedProfiles,
  farewellPhrase,
  MAX_THERAPIST_TURNS,
  SIMULATOR_KEYS,
  publicProfile,
  publicSession,
  sanitizeText,
  validateRatings
} from "../src/index.js";
import { generatePatientActResponse, patientActSystemPrompt } from "../src/patient_act.js";
import { generatePatientPsiResponse, patientPsiSystemPrompt } from "../src/patient_psi.js";
import { strictObject, structuredResponse } from "../src/openai.js";
import { PROFILES } from "../src/profiles.js";
import {
  buildTopasProfile,
  generateTopasResponse,
  initialTopasState,
  validateTopasState
} from "../src/topas.js";

test("the three requested simulators are configured", () => {
  assert.deepEqual(SIMULATOR_KEYS, ["patient_psi", "patient_act", "topas"]);
  assert.equal(MAX_THERAPIST_TURNS, 50);
});

test("the two experts receive distinct sets of 20 profiles", () => {
  const env = { PROFILE_ASSIGNMENTS: "EXPERT-5136:1-20,EXPERT-8427:21-40" };
  const first = assignedProfiles(env, "expert-5136");
  const second = assignedProfiles(env, "EXPERT-8427");
  assert.equal(PROFILES.length, 40);
  assert.equal(first.length, 20);
  assert.equal(second.length, 20);
  assert.equal(first.some(profile => second.some(other => other.id === profile.id)), false);
  assert.deepEqual(first.map(profile => profile.display_number), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(second.map(profile => profile.display_number), Array.from({ length: 20 }, (_, index) => index + 21));
});

test("farewell detection matches the simulation pipeline", () => {
  for (const example of [
    "Patient: Patient: Okay. Um… bye.",
    "Therapist: Bye-bye.",
    "Okay, take care. I will see you next week. Bye bye.",
    "good bye",
    "good-bye",
    "goodbye"
  ]) {
    assert.ok(farewellPhrase(example), example);
  }
  for (const example of [
    "This should bypass the issue.",
    "That was a good byproduct.",
    "I said goodbye to my father.",
    "It can be hard to say goodbye.",
    "The word goodbye feels final."
  ]) {
    assert.equal(farewellPhrase(example), null, example);
  }
});

test("browser-safe profiles omit source and private prompt data", () => {
  const result = publicProfile(PROFILES[0]);
  assert.equal(result.id, "case-01");
  assert.equal("source_id" in result, false);
  assert.equal("prompt_profile" in result, false);
  assert.ok(result.summary.length > 20);
});

test("browser-safe sessions never expose simulator identity", () => {
  const result = publicSession({
    id: "session-1",
    simulator_key: "patient_act",
    anonymous_label: "Patient session A",
    display_order: 1,
    status: "active"
  }, [{ role: "patient", content: "Hello" }, { role: "therapist", content: "Hello" }]);
  assert.equal(result.anonymous_label, "Patient session A");
  assert.equal("simulator_key" in result, false);
  assert.equal(result.can_send, true);
  assert.equal(result.can_end, true);
});

test("ratings require every PatientAct metric on a 1-5 integer scale", () => {
  const scores = { coherence: 5, disclosure: 4, resistance: 3, emotional: 2, realism: 1 };
  assert.deepEqual(validateRatings(scores), scores);
  assert.throws(() => validateRatings({ ...scores, realism: 6 }), /realism/);
  assert.throws(() => validateRatings({ ...scores, disclosure: 3.5 }), /disclosure/);
  assert.throws(() => validateRatings({ coherence: 5 }), /disclosure/);
});

test("TOPAS profile adapter populates the complete extracted CBT schema", () => {
  const profile = buildTopasProfile(PROFILES[0].prompt_profile);
  assert.equal(profile.static_dimensions.length, 12);
  assert.equal(profile.dynamic_dimensions.length, 14);
  assert.ok(profile.static_dimensions.every(dimension => typeof dimension.value === "string" && dimension.value.length));
  const initial = initialTopasState(profile);
  assert.deepEqual(validateTopasState(initial, profile), initial);
  assert.match(profile.static_dimensions[0].value, /Robert Miller/);
});

test("TOPAS runs state update then utterance generation and advances its checkpoint", async () => {
  const env = { MOCK_OPENAI: "true" };
  const promptProfile = PROFILES[0].prompt_profile;
  const firstHistory = [{ role: "therapist", content: "What would you like to focus on today?" }];
  const first = await generateTopasResponse(env, promptProfile, firstHistory, { turn: 0 }, "TEST");
  assert.ok(first.content.length > 20);
  assert.equal(first.state.turn, 1);
  assert.equal(first.state.topas.checkpoint_message_count, 1);
  assert.equal(Object.keys(first.state.topas.dynamic_state.dynamic_states).length, 14);

  const history = [
    ...firstHistory,
    { role: "patient", content: first.content },
    { role: "therapist", content: "What feels most difficult about changing that pattern?" }
  ];
  const next = await generateTopasResponse(env, promptProfile, history, first.state, "TEST");
  assert.ok(next.content.length > 20);
  assert.notEqual(next.content, first.content);
  assert.equal(next.state.turn, 2);
  assert.equal(next.state.topas.checkpoint_message_count, history.length);
});

test("standalone live simulators preserve their full distinct mechanisms", async () => {
  const profile = PROFILES[0];
  const promptProfile = profile.prompt_profile;
  const actPrompt = patientActSystemPrompt(promptProfile.patient_act_case);
  assert.match(actPrompt, /You will receive <signal> tags/);
  assert.match(actPrompt, new RegExp(promptProfile.demographics.name));

  const env = { MOCK_OPENAI: "true" };
  const act = await generatePatientActResponse(
    env, promptProfile.patient_act_case, "Hello. What would you like to focus on today?", { turn: 0 }, "TEST"
  );
  assert.equal(act.state.patient_act.history.length, 2);
  assert.equal(act.state.patient_act.trust_level, 2.5);
  assert.ok(act.content.length > 20);

  const psi = await generatePatientPsiResponse(
    env, promptProfile, "Hello. What would you like to focus on today?", { turn: 0 }, "TEST"
  );
  assert.match(patientPsiSystemPrompt(psi.state.patient_psi_model), /Cognitive Conceptualization Diagram/);
  assert.equal(psi.state.patient_psi_history.length, 2);
  assert.ok(psi.content.length > 20);
});

test("all 40 patient profiles run through PatientAct, Patient-Ψ, and TOPAS", async () => {
  const env = { MOCK_OPENAI: "true" };
  for (const profile of PROFILES) {
    const promptProfile = profile.prompt_profile;
    const therapistMessage = "What feels most important for us to discuss today?";
    const act = await generatePatientActResponse(
      env, promptProfile.patient_act_case, therapistMessage, { turn: 0 }, "PROFILE-CHECK"
    );
    const psi = await generatePatientPsiResponse(
      env, promptProfile, therapistMessage, { turn: 0 }, "PROFILE-CHECK"
    );
    const topas = await generateTopasResponse(
      env, promptProfile, [{ role: "therapist", content: therapistMessage }], { turn: 0 }, "PROFILE-CHECK"
    );
    assert.ok(act.content.length > 20, `${profile.id} PatientAct response`);
    assert.ok(psi.content.length > 20, `${profile.id} Patient-Ψ response`);
    assert.ok(topas.content.length > 20, `${profile.id} TOPAS response`);
    assert.equal(Object.keys(topas.state.topas.dynamic_state.dynamic_states).length, 14, `${profile.id} TOPAS state`);
  }
});

test("live OpenAI calls use GPT-5.1 Responses structured outputs", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: "{\"value\":\"ok\"}" }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await structuredResponse(
      { MOCK_OPENAI: "false", OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-5.1" },
      {
        name: "test_schema",
        schema: strictObject({ value: { type: "string" } }),
        instructions: "Return a test value.",
        participantCode: "EXPERT-TEST"
      }
    );
    assert.deepEqual(result, { value: "ok" });
    assert.equal(requestBody.model, "gpt-5.1");
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.text.format.type, "json_schema");
    assert.equal(requestBody.text.format.strict, true);
    assert.equal(requestBody.safety_identifier.length, 32);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live standalone pipelines execute every original decision stage", async () => {
  const outputs = {
    patient_act_topics: { topics: ["fear of missed warning signs"] },
    patient_act_reaction: { reasoning: "The question touches an active fear.", reaction: "scared", intensity: "high" },
    patient_act_behavior: { reasoning: "Trust is low around sensitive material.", behavior: "resistance" },
    patient_act_resistance: { reasoning: "The patient becomes guarded.", pattern: "defensiveness" },
    patient_act_response: { reasoning: "Deflect without disclosing blocked content.", content: "I don't think you're understanding why this feels so serious to me." },
    patient_act_trust: { reasoning: "The patient felt pushed.", direction: "decreased_slightly" },
    patient_psi_model: {
      intermediate_beliefs_during_depression: ["If I let my guard down, something bad will happen."],
      automatic_thoughts: ["They may be missing something important."],
      emotions: ["anxious/worried/fearful/scared/tense"],
      behaviors: ["Checks repeatedly and seeks reassurance."]
    },
    patient_psi_response: { content: "I keep thinking something important has been missed, even when people reassure me." }
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const name = body.text.format.name;
    calls.push(name);
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(outputs[name]) }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const env = { MOCK_OPENAI: "false", OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-5.1" };
    const profile = PROFILES[0].prompt_profile;
    const act = await generatePatientActResponse(
      env, profile.patient_act_case, "Why can't you accept that the tests were normal?", { turn: 0 }, "TEST"
    );
    assert.deepEqual(calls, [
      "patient_act_topics",
      "patient_act_reaction",
      "patient_act_behavior",
      "patient_act_resistance",
      "patient_act_response",
      "patient_act_trust"
    ]);
    assert.equal(act.state.patient_act.trust_level, 2.25);
    assert.equal(act.state.patient_act.resistance_pattern, "defensiveness");

    calls.length = 0;
    const firstPsi = await generatePatientPsiResponse(env, profile, "What has this week been like?", { turn: 0 }, "TEST");
    assert.deepEqual(calls, ["patient_psi_model", "patient_psi_response"]);
    calls.length = 0;
    await generatePatientPsiResponse(env, profile, "What goes through your mind then?", firstPsi.state, "TEST");
    assert.deepEqual(calls, ["patient_psi_response"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live TOPAS executes its two GPT-5.1 stages with full prompt artifacts", async () => {
  const promptProfile = PROFILES[0].prompt_profile;
  const profile = buildTopasProfile(promptProfile);
  const stateOutput = initialTopasState(profile);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const text = body.text?.format?.name === "topas_state_update"
      ? JSON.stringify(stateOutput)
      : "I keep checking because the reassurance never seems to last very long.";
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const env = { MOCK_OPENAI: "false", OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-5.1" };
    const result = await generateTopasResponse(
      env,
      promptProfile,
      [{ role: "therapist", content: "What would you like to focus on today?" }],
      { turn: 0 },
      "TEST"
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].text.format.name, "topas_state_update");
    assert.equal(requests[1].text.format, undefined);
    assert.match(requests[0].instructions, /<current_state>/);
    assert.match(requests[1].instructions, /<updated_state>/);
    assert.match(result.content, /reassurance/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("text sanitization trims and enforces limits", () => {
  assert.equal(sanitizeText("  hello  ", 10), "hello");
  assert.equal(sanitizeText("abcdefgh", 4), "abcd");
});
