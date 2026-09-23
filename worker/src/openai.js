function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safetyIdentifier(participantCode) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(participantCode || "anonymous")));
  return base64Url(new Uint8Array(digest)).slice(0, 32);
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  throw new Error("OpenAI returned no output text");
}

function apiKey(env) {
  return env.OPENAI_API_KEY || env.AZURE_OPENAI_API_KEY || "";
}

function responsesUrl(env) {
  return `${String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
}

function mockStructured(name, input, instructions) {
  const transcript = Array.isArray(input)
    ? input.map(item => String(item?.content || "")).join("\n")
    : String(input || "");
  const turn = Math.max(1, Array.isArray(input)
    ? input.filter(item => item?.role === "user").length
    : (transcript.match(/Therapist:/g) || []).length);
  const mocks = {
    patient_act_topics: { topics: [] },
    patient_act_reaction: { reasoning: "Mock mode", reaction: "no_reaction", intensity: "low" },
    patient_act_behavior: { reasoning: "Mock mode", behavior: turn % 2 ? "recounting" : "simple_response" },
    patient_act_resistance: { reasoning: "Mock mode", pattern: "minimal_talk" },
    patient_act_response: {
      reasoning: "Mock mode",
      content: turn % 2
        ? "I've been trying to make sense of it, but I keep getting pulled back into the same worries."
        : "I suppose part of me wants help, even though talking about it still feels uncomfortable."
    },
    patient_act_trust: { reasoning: "Mock mode", direction: "unchanged" },
    patient_psi_model: {
      intermediate_beliefs_during_depression: ["If I cannot cope on my own, I am failing."],
      automatic_thoughts: ["This is going to keep getting worse."],
      emotions: ["anxious/worried/fearful/scared/tense"],
      behaviors: ["Withdraws and repeatedly worries about the situation."]
    },
    patient_psi_response: {
      content: turn % 2
        ? "Lately it feels like the worry takes over before I can get any perspective on it."
        : "I know I keep circling around the same thoughts, but they feel convincing when I'm in the middle of them."
    }
  };
  if (name === "topas_state_update") {
    const state = String(instructions || "").match(/<current_state>\s*([\s\S]*?)\s*<\/current_state>/i)?.[1];
    if (!state) throw new Error("Mock TOPAS state prompt is missing current_state");
    return JSON.parse(state);
  }
  if (!(name in mocks)) throw new Error(`No mock structured response for ${name}`);
  return mocks[name];
}

export async function structuredResponse(env, {
  name,
  schema,
  instructions,
  input = "Return the requested result.",
  participantCode,
  maxOutputTokens = 500
}) {
  if (String(env.MOCK_OPENAI || "false").toLowerCase() === "true") return mockStructured(name, input, instructions);
  const key = apiKey(env);
  if (!key) throw new Error("An OpenAI API key is not configured");

  const response = await fetch(responsesUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.1",
      reasoning: { effort: "none" },
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema
        }
      },
      safety_identifier: await safetyIdentifier(participantCode),
      store: false
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
  }
  const output = extractOutputText(payload);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`OpenAI returned invalid structured output for ${name}`);
  }
}

export async function textResponse(env, {
  instructions,
  input = "Return the requested response.",
  participantCode,
  maxOutputTokens = 500,
  mockName = "text_response"
}) {
  if (String(env.MOCK_OPENAI || "false").toLowerCase() === "true") {
    const transcript = String(input || "");
    const turn = Math.max(1, (transcript.match(/Therapist:/g) || []).length);
    if (mockName === "topas_utterance") {
      return turn % 2
        ? "It has been hard to get out of the same pattern, even when I can see that it is wearing me down."
        : "I can understand that idea, but part of me still feels unsure about changing what I usually do."
    }
    throw new Error(`No mock text response for ${mockName}`);
  }
  const key = apiKey(env);
  if (!key) throw new Error("An OpenAI API key is not configured");

  const response = await fetch(responsesUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.1",
      reasoning: { effort: "none" },
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      text: { verbosity: "low" },
      safety_identifier: await safetyIdentifier(participantCode),
      store: false
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
  }
  return extractOutputText(payload);
}

export const stringArraySchema = {
  type: "array",
  items: { type: "string" }
};

export function strictObject(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}
