import { strictObject, textResponse, structuredResponse } from "./openai.js";
import {
  TOPAS_PROFILE_SCHEMA,
  TOPAS_STATE_UPDATE_TEMPLATE,
  TOPAS_UTTERANCE_TEMPLATE
} from "./topas_data.js";

const COMMON_FIELDS = {
  domain: "cognitive behavioral therapy",
  user_role: "Patient",
  system_role: "Therapist",
  interaction_unit: "session"
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function array(value) {
  return Array.isArray(value)
    ? value.filter(item => item !== null && item !== undefined && (typeof item === "object" || String(item).trim()))
    : [];
}

function readable(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  if (Array.isArray(value)) return value.length ? value.map(readable).join("; ") : "unknown";
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "");
    return entries.length ? entries.map(([key, item]) => `${key.replaceAll("_", " ")}: ${readable(item)}`).join("; ") : "unknown";
  }
  return String(value).trim() || "unknown";
}

function joined(...values) {
  const rendered = values.map(readable).filter(value => value !== "unknown");
  return rendered.length ? rendered.join("\n") : "unknown";
}

function optionValues(text, candidates) {
  const normalized = String(text || "").toLowerCase();
  const selected = candidates.filter(([needle]) => normalized.includes(needle)).map(([, value]) => value);
  return [...new Set(selected)];
}

function initialDynamicValues(promptProfile) {
  const combined = JSON.stringify(promptProfile).toLowerCase();
  const condition = array(promptProfile.presenting_conditions).join(" ").toLowerCase();
  const style = String(promptProfile.conversational_style || "plain").toLowerCase();
  const emotions = condition.includes("depress") ? ["sadness/low mood"] : ["anxiety/fear"];
  if (/anger|angry|irritab|frustrat/.test(String(promptProfile.emotional_range || "").toLowerCase())) {
    emotions.push("anger/irritability");
  }

  const coping = optionValues(combined, [
    ["reassurance", "reassurance seeking"],
    ["check", "checking/ritualizing"],
    ["avoid", "behavioral avoidance"],
    ["withdraw", "emotional avoidance"],
    ["safety", "safety behaviors"],
    ["substance", "maladaptive coping"]
  ]);
  const cognition = ["rigid/automatic negative thoughts", "schema activation"];
  if (/catastroph|worst.case|danger|threat/.test(combined)) cognition.push("catastrophizing");
  if (/uncertain|uncertainty|certainty/.test(combined)) cognition.push("intolerance of uncertainty");
  if (/risk|danger|threat|illness|symptom/.test(combined)) cognition.push("overestimation of risk");

  return {
    "Current Emotional State/Affect": [...new Set(emotions)],
    "Symptom Severity/Distress Level": "moderate",
    "Profile of Current Symptoms/Diagnosis": "unchanged",
    "Motivation and Readiness for Change/Treatment/Exposure": "ambivalent/mixed",
    "Session Engagement and Participation": ["partially engaged"],
    "Current Coping and Avoidance Strategies": coping.length ? coping : ["unknown"],
    "Cognitive Flexibility, Automatic Thoughts, and Reappraisal": [...new Set(cognition)],
    "Attention and Symptom Monitoring": /check|monitor|vigil|symptom/.test(combined)
      ? ["internally focused", "symptom scanning"]
      : ["internally focused"],
    "Awareness, Insight, and Self-monitoring": "partial/intermittent insight",
    "Willingness and Openness to Disclose/Engage": style === "reserved" ? "guarded/reluctant" : "partially/selectively open",
    "Therapeutic Alliance and Support Network Involvement": "unknown",
    "Adherence and Response to Assignments/Tasks": "unknown",
    "Generalization and Maintenance of Therapy Gains": "unknown",
    "Medication Use and Side Effects": ["unknown"]
  };
}

export function buildTopasProfile(promptProfile) {
  const schema = clone(TOPAS_PROFILE_SCHEMA);
  const patientAct = promptProfile.patient_act_case || {};
  const caseProfile = patientAct.profile || {};
  const demographics = caseProfile.demographics || promptProfile.demographics || {};
  const problem = caseProfile.problem_formulation || {};
  const psychological = caseProfile.psychological_formulation || {};
  const predisposing = problem.predisposing_factors || {};
  const protective = problem.protective_factors || {};
  const seed = patientAct.seed || {};

  const staticValues = {
    "Demographics, Identity, and Social Context": joined(demographics, predisposing.social),
    "Personal and Developmental History": joined(promptProfile.relevant_history, predisposing.psychological),
    "Core Beliefs, Schemas, and Interpretations": joined(
      { core_beliefs: promptProfile.core_beliefs, core_belief_theme: seed.core_belief_theme },
      { intermediate_beliefs: promptProfile.intermediate_beliefs, automatic_thoughts: promptProfile.automatic_thoughts }
    ),
    "Personality Traits and Communication Style": joined({
      conversational_style: promptProfile.conversational_style,
      attachment_style: promptProfile.attachment_style || seed.attachment_style,
      emotional_range: promptProfile.emotional_range,
      interpersonal_patterns: promptProfile.interpersonal_patterns
    }),
    "Diagnostic and Comorbidity Profile": joined(
      { presenting_conditions: promptProfile.presenting_conditions },
      promptProfile.summary,
      problem.presenting_problem
    ),
    "Trauma and Index Events": "unknown",
    "Habitual Coping Strategies and Safety Behaviors": joined(promptProfile.coping_strategies, psychological.coping_patterns, problem.perpetuating_factors),
    "Strengths, Support Resources, and Constraints": joined(protective),
    "Treatment, Therapy, and Medication History": "unknown",
    "Personal Goals, Values, and Motivation": joined(promptProfile.current_stressor),
    "Contextual Triggers and Avoided Situations": joined(promptProfile.triggers, psychological.triggers, problem.precipitating_factors),
    "Cognitive and Learning Capacity": "unknown"
  };
  const initial = initialDynamicValues(promptProfile);

  schema.static_dimensions = schema.static_dimensions.map(dimension => ({
    ...dimension,
    value: staticValues[dimension.dimension_name] || "unknown"
  }));
  schema.dynamic_dimensions = schema.dynamic_dimensions.map(dimension => ({
    ...dimension,
    initial_value: initial[dimension.dimension_name] ?? (dimension.selection_mode === "multiple" ? ["unknown"] : "unknown")
  }));
  return schema;
}

export function initialTopasState(profile) {
  return {
    dynamic_states: Object.fromEntries(
      profile.dynamic_dimensions.map(dimension => [dimension.dimension_name, clone(dimension.initial_value)])
    )
  };
}

function stateSchema(profile) {
  const properties = Object.fromEntries(profile.dynamic_dimensions.map(dimension => {
    const item = { type: "string", enum: dimension.options };
    return [dimension.dimension_name, dimension.selection_mode === "multiple"
      ? { type: "array", items: item, minItems: 1 }
      : item];
  }));
  return strictObject({ dynamic_states: strictObject(properties) });
}

export function validateTopasState(candidate, profile) {
  const states = candidate?.dynamic_states;
  if (!states || typeof states !== "object" || Array.isArray(states)) throw new Error("TOPAS returned no dynamic state map");
  const expected = profile.dynamic_dimensions.map(dimension => dimension.dimension_name);
  const actual = Object.keys(states);
  if (actual.length !== expected.length || expected.some(name => !Object.hasOwn(states, name))) {
    throw new Error("TOPAS returned incomplete dynamic state dimensions");
  }
  for (const dimension of profile.dynamic_dimensions) {
    const value = states[dimension.dimension_name];
    const options = new Set(dimension.options);
    if (dimension.selection_mode === "single") {
      if (typeof value !== "string" || !options.has(value)) throw new Error(`Invalid TOPAS state for ${dimension.dimension_name}`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !options.has(item))) {
      throw new Error(`Invalid TOPAS state for ${dimension.dimension_name}`);
    }
    if (new Set(value).size !== value.length || (value.includes("unknown") && value.length !== 1)) {
      throw new Error(`Invalid TOPAS multi-select state for ${dimension.dimension_name}`);
    }
  }
  return { dynamic_states: clone(states) };
}

function renderTemplate(template, fields) {
  const left = "\u0000TOPAS_LEFT\u0000";
  const right = "\u0000TOPAS_RIGHT\u0000";
  return template
    .replaceAll("{{", left)
    .replaceAll("}}", right)
    .replace(/\{([a-z_]+)\}/g, (match, name) => Object.hasOwn(fields, name) ? String(fields[name]) : match)
    .replaceAll(left, "{")
    .replaceAll(right, "}");
}

function transcript(messages) {
  return messages.map(message => `${message.role === "therapist" ? "Therapist" : "Patient"}: ${message.content}`).join("\n");
}

export async function generateTopasResponse(env, promptProfile, messages, state, participantCode) {
  const profile = buildTopasProfile(promptProfile);
  const prior = state.topas || {};
  const currentState = validateTopasState(prior.dynamic_state || initialTopasState(profile), profile);
  const publicHistory = array(messages).map(message => ({ role: message.role, content: String(message.content || "") }));
  if (!publicHistory.some(message => message.role === "therapist")) throw new Error("A therapist message is required");
  const fullHistory = publicHistory;
  const checkpoint = Math.max(0, Math.min(Number(prior.checkpoint_message_count || 0), publicHistory.length));
  const newMessages = publicHistory.slice(checkpoint);
  const common = {
    ...COMMON_FIELDS,
    profile: JSON.stringify(profile),
    current_state: JSON.stringify(currentState),
    new_messages: JSON.stringify(newMessages.map(message => ({
      role: message.role === "therapist" ? "Therapist" : "Patient",
      content: message.content
    })))
  };
  const conversation = transcript(fullHistory);
  const updated = await structuredResponse(env, {
    name: "topas_state_update",
    schema: stateSchema(profile),
    instructions: renderTemplate(TOPAS_STATE_UPDATE_TEMPLATE, common),
    input: conversation,
    participantCode,
    maxOutputTokens: 1200
  });
  const dynamicState = validateTopasState(updated, profile);
  const utterance = await textResponse(env, {
    instructions: renderTemplate(TOPAS_UTTERANCE_TEMPLATE, {
      ...COMMON_FIELDS,
      profile: JSON.stringify(profile),
      updated_state: JSON.stringify(dynamicState)
    }),
    input: conversation,
    participantCode,
    maxOutputTokens: 500,
    mockName: "topas_utterance"
  });
  const content = String(utterance || "").replace(/^\s*(?:patient|client)\s*:\s*/i, "").trim();
  if (!content) throw new Error("TOPAS returned an empty patient response");
  return {
    content,
    state: {
      ...state,
      turn: Number(state.turn || 0) + 1,
      topas: {
        dynamic_state: dynamicState,
        checkpoint_message_count: publicHistory.length,
        artifact_version: 1
      }
    }
  };
}
