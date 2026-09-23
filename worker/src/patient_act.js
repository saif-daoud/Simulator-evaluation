import { strictObject, stringArraySchema, structuredResponse } from "./openai.js";

export const TRUST_DELTAS = {
  increased_significantly: 0.5,
  increased_slightly: 0.25,
  unchanged: 0,
  decreased_slightly: -0.25,
  decreased_significantly: -0.5
};

export const REACTIONS = {
  understood: "The client felt the therapist accurately grasped what they were saying or feeling. They feel heard and seen.",
  hopeful: "The client felt more optimistic, encouraged, or reassured. A sense that things could get better.",
  gained_clarity: "The client gained new awareness: saw a pattern, made a connection, or understood something about themselves they hadn't before. Includes moments of insight, feeling less confused, or seeing things from a new angle.",
  challenged: "The client felt pushed to think differently or confront something uncomfortable. This can be productive or threatening depending on the client's trust and readiness.",
  scared: "The client felt frightened, anxious, or emotionally overwhelmed. This could be due to the therapist touching on something very sensitive, pushing too hard, or moving too fast.",
  misunderstood: "The client felt the therapist missed the point, got it wrong, or was not on the same page. May trigger correction, frustration, or withdrawal.",
  no_reaction: "The client felt nothing notable in response to the therapist's message. The intervention did not land."
};

export const BEHAVIORS = {
  simple_response: "The client gives brief acknowledgments, 'yes,' 'okay,' 'I see,' or minimal verbal responses that confirm hearing the therapist but don't elaborate.",
  request: "The client asks for something: information, clarification, advice, or the therapist's opinion. Can be genuine help-seeking or reassurance-seeking.",
  recounting: "The client narrates events or tells stories — factual, descriptive, external. Reporting what happened rather than exploring meaning.",
  cognitive_exploration: "The client examines their own thoughts, beliefs, assumptions, or patterns. Goes beyond recounting into active self-analysis.",
  affective_exploration: "The client explores, expresses, or elaborates on emotions. Naming feelings, connecting them to events, or experiencing them in session.",
  insight: "The client demonstrates a new understanding — connecting patterns, recognizing causes, an 'aha' moment. A qualitative shift, not just description.",
  discussing_plans: "The client talks about changes they want to make, actions they intend to try, or new behaviors they have already attempted.",
  resistance: "The client opposes, deflects, avoids, or blocks the therapeutic process."
};

export const RESISTANCE_PATTERNS = {
  minimal_talk: "Very brief, unelaborated answers. 'I guess,' 'I don't know', 'not really.'",
  irrelevant_talk: "Steering the conversation to unrelated topics to avoid the current issue.",
  superficial: "Staying on surface-level facts and details, avoiding emotional depth.",
  intellectualizing: "Using analysis, abstract reasoning, or clinical language to avoid experiencing emotions. Talking ABOUT feelings rather than FEELING.",
  hostility: "Anger, sarcasm, or sharp criticism directed at the therapist, the process, or the questions being asked.",
  defensiveness: "Justifying, denying, or explaining away problems when confronted. 'It's not that bad,' 'you don't understand.'",
  compliance_without_engagement: "Agreeing with everything the therapist says without genuine engagement. 'Yeah, you're right' followed by no change."
};

const TOPIC_SCHEMA = strictObject({ topics: stringArraySchema });
const REACTION_SCHEMA = strictObject({
  reasoning: { type: "string" },
  reaction: { type: "string", enum: Object.keys(REACTIONS) },
  intensity: { type: "string", enum: ["low", "moderate", "high"] }
});
const BEHAVIOR_SCHEMA = strictObject({
  reasoning: { type: "string" },
  behavior: { type: "string", enum: Object.keys(BEHAVIORS) }
});
const RESISTANCE_SCHEMA = strictObject({
  reasoning: { type: "string" },
  pattern: { type: "string", enum: Object.keys(RESISTANCE_PATTERNS) }
});
const RESPONSE_SCHEMA = strictObject({ reasoning: { type: "string" }, content: { type: "string" } });
const TRUST_SCHEMA = strictObject({
  reasoning: { type: "string" },
  direction: { type: "string", enum: Object.keys(TRUST_DELTAS) }
});

function bullets(values) {
  return (values || []).map(value => `- ${value}`).join("\n");
}

function describedOptions(options) {
  return Object.entries(options).map(([key, description]) => `- ${key}: ${description}`).join("\n");
}

function conversationText(history) {
  return history.map(message => `${message.role === "user" ? "Therapist" : "Client"}: ${message.content}`).join("\n");
}

function tagMemoryItem(item) {
  const tags = {
    triggers: "trigger",
    intermediate_beliefs: "belief",
    automatic_thoughts: "thought",
    perpetuating_factors: "pattern",
    interpersonal_patterns: "relational pattern",
    impact: "symptom",
    predisposing_factors: "memory"
  };
  for (const [field, label] of Object.entries(tags)) {
    if (String(item.field_path || "").includes(field)) return `[${label}] ${item.content}`;
  }
  return item.content;
}

function retrieveMemory(caseData, topics, trustLevel) {
  const topicSet = new Set((topics || []).map(topic => String(topic).toLowerCase()));
  const items = [];
  const blocked = [];
  for (const item of caseData.memory?.items || []) {
    if (!(item.activation_tags || []).some(tag => topicSet.has(String(tag).toLowerCase()))) continue;
    if (trustLevel >= Number(item.disclosure_level)) items.push(tagMemoryItem(item));
    else if (item.generates_discomfort) blocked.push(item.content);
  }
  return {
    topics,
    items,
    has_triggers: items.some(item => item.startsWith("[trigger]")),
    blocked
  };
}

export function patientActSystemPrompt(caseData) {
  const profile = caseData.profile;
  const demographics = profile.demographics;
  const problem = profile.problem_formulation;
  const psychological = profile.psychological_formulation;
  const therapistPattern = (psychological.interpersonal_patterns || []).find(pattern => pattern.domain === "the therapist");
  return `You are ${demographics.name}, a ${demographics.gender} (${demographics.age_group}) who works as ${demographics.occupation}. You are ${demographics.marital_status}.
Cultural background: ${demographics.cultural_background}

You are attending a therapy session. Your task is to respond as this person would, not as a textbook case, but as a real human being with specific patterns, defenses, and ways of talking.

## Reasons for attending therapy
${problem.presenting_problem.situation}

## What triggered this
${bullets(problem.precipitating_factors)}

## Strengths and supports
${bullets([...(problem.protective_factors?.internal || []), ...(problem.protective_factors?.external || [])])}

## Coping patterns
${bullets(psychological.coping_patterns)}

## Available emotions
${psychological.emotional_range}

## How you relate to the therapist
${therapistPattern ? `- What you want: ${therapistPattern.wish}\n- What you expect from them: ${therapistPattern.response_of_other}\n- How you react: ${therapistPattern.response_of_self}` : ""}

## Guidelines
1. Speak as ${demographics.name} would: use their vocabulary, pace, and verbal patterns. Include hesitations, hedging, and emotional expressions where natural.
2. Do NOT dump information. Share only what feels natural for this conversation.
3. Respond directly. Do not include any role labels or prefixes like "Client:" or "Patient:".
4. Speak in first person. Keep responses to 1-3 sentences unless emotionally activated.
5. If the therapist greets you, open the conversation as the client would.
6. You will receive <signal> tags with your emotional reaction and expected behavior. Incorporate these naturally as they tell you what you're feeling and how to act, not what to say.`;
}

function reactionPrompt({ history, context, previousReaction }) {
  const activated = context.items.length || context.blocked.length;
  return `Identify the therapy client's emotional reaction to the therapist's latest message.

## Possible reactions
${describedOptions(REACTIONS)}
${previousReaction ? `\n## Previous reaction: ${previousReaction}\n` : ""}
## Conversation
${history}

${activated ? `## What this is activating in the client
${bullets(context.items)}
${context.has_triggers ? "Note: [trigger] items directly activate distress. Reactions are likely more intense.\n" : ""}${context.blocked.length ? "- [sensitive area] The topic approaches content the client is not ready to discuss.\n" : ""}` : "## Nothing in the client's belief system or history is specifically activated.\n"}
${previousReaction ? `Previous reaction: ${previousReaction}\n\n` : ""}Identify the reaction and its intensity (low, moderate, high). If nothing is activated, most likely "no_reaction" with low intensity.`;
}

function behaviorPrompt({ history, context, psychological, reaction, trustLevel, recentBehaviors }) {
  return `Predict the therapy client's next behavior based on their emotional reaction.

## Possible behaviors
${describedOptions(BEHAVIORS)}

## Current state
- Reaction: ${reaction.reaction} (${reaction.intensity}) — ${REACTIONS[reaction.reaction]}
- Trust level: ${trustLevel}/4.0
${context.blocked.length ? "- The topic approaches sensitive content the client is not ready to share.\n" : ""}
## Coping patterns
${bullets(psychological.coping_patterns)}

Recent behaviors (most recent last): ${JSON.stringify(recentBehaviors)}

## Conversation
${history}

## Guidance
- Nothing activated + neutral reaction → "simple_response" or "recounting."
- HIGH intensity + LOW trust → "resistance" is likely.
- Topic touches blocked content → "resistance" is likely.
- Positive reaction + moderate intensity → therapeutic behaviors.
- Neutral/low reaction → "simple_response" or "recounting."
- Avoid repeating the same behavior three turns in a row.
- After 2+ consecutive therapeutic behaviors (cognitive_exploration, affective_exploration, insight, discussing_plans), the client naturally pulls back — simpler response, doubt, or deflection.

Select the single most appropriate behavior.`;
}

function resistancePrompt({ history, context, psychological, reaction, trustLevel }) {
  return `The client is resisting. Determine the specific form of resistance.

## Possible patterns
${describedOptions(RESISTANCE_PATTERNS)}

## Context
- Reaction: ${reaction.reaction} (${reaction.intensity})
- Trust level: ${trustLevel}/4.0

## Coping patterns
${bullets(psychological.coping_patterns)}

${context.blocked.length ? "The topic approaches sensitive content the client is not ready to share.\n" : ""}
## Recent conversation
${history}

Select the resistance pattern that best matches how this client would resist right now.`;
}

function signalPrompt({ context, reaction, behavior, resistancePattern }) {
  return `<signal>
Reaction: ${reaction.reaction} (${reaction.intensity}) — ${REACTIONS[reaction.reaction]}
Behavior: ${behavior.behavior} — ${BEHAVIORS[behavior.behavior]}
${resistancePattern ? `Resistance: ${resistancePattern} — ${RESISTANCE_PATTERNS[resistancePattern]}\n` : ""}
${context.items.length ? `Activated:\n${bullets(context.items)}\n` : ""}
${context.blocked.length ? "⚠ The topic approaches sensitive content you are NOT ready to share. Do not disclose it. Show discomfort — change the subject, give a vague answer, go quiet, or deflect.\n" : ""}</signal>`;
}

function trustPrompt({ history, attachmentStyle, therapistExpectation, trustLevel }) {
  const attachmentGuidance = {
    anxious: "Trust is easily lost on perceived rejection. Builds with consistent warmth but gains are fragile.",
    avoidant: "Trust moves slowly. Pushing for disclosure decreases trust. Respecting distance builds it gradually.",
    disorganized: "Trust is volatile. May decrease after sharing something vulnerable, even if the therapist responds well.",
    secure: "Trust moves in a balanced way. Missteps can be repaired."
  }[attachmentStyle] || "";
  return `Assess how a therapy client's trust changed after the latest exchange.

## Trust scale
1.0=active refusal, 2.0=hesitant, 2.5=session start, 3.0=building trust, 4.0=fully open.

## Client context
- Attachment style: ${attachmentStyle}
${attachmentGuidance ? `- ${attachmentGuidance}\n` : ""}- What the client expects from the therapist: ${therapistExpectation}
- Current trust: ${trustLevel}/4.0

## Latest exchange
${history}

Your task is to determine how the therapist's latest message affected trust.

## Guidelines
The default outcome is "unchanged". Only select "increased" or "decreased" when something notable happens.

## What INCREASES trust
- The therapist respected a redirect or resistance instead of pushing through
- The therapist named something accurate that the client had not said explicitly
- The therapist sat with discomfort or silence rather than rushing to fill it
- The therapist adjusted their approach after sensing the client pulling back

## What keeps trust UNCHANGED:
- A standard empathic reflection ("it sounds like...")
- A reasonable follow-up question
- Validating what the client just said
- The conversation proceeding normally

## What DECREASES trust
- Pushing for disclosure the client is not ready for
- Using a technique or reframe before the client invited it
- Missing or talking past resistance
- Formulaic or generic responses that feel scripted`;
}

export async function generatePatientActResponse(env, caseData, therapistMessage, state, participantCode) {
  const prior = state.patient_act || {};
  const trustLevel = Number(prior.trust_level ?? 2.5);
  const history = [...(prior.history || []), { role: "user", content: therapistMessage }];
  const flattened = conversationText(history);
  const activationTags = [...new Set((caseData.memory?.items || []).flatMap(item => item.activation_tags || []))].sort();

  const topics = await structuredResponse(env, {
    name: "patient_act_topics",
    schema: TOPIC_SCHEMA,
    instructions: `Given the therapist's latest message, identify which topics from this list are relevant. Return ONLY matching topics. If no topics match, return an empty list.

Available topics:
${JSON.stringify(activationTags)}

Therapist's message:
"${therapistMessage}"`,
    participantCode,
    maxOutputTokens: 250
  });
  const context = retrieveMemory(caseData, topics.topics, trustLevel);

  const reaction = await structuredResponse(env, {
    name: "patient_act_reaction",
    schema: REACTION_SCHEMA,
    instructions: reactionPrompt({ history: flattened, context, previousReaction: prior.reaction }),
    participantCode,
    maxOutputTokens: 350
  });

  const psychological = caseData.profile.psychological_formulation;
  const recentBehaviors = prior.recent_behaviors || [];
  const behavior = await structuredResponse(env, {
    name: "patient_act_behavior",
    schema: BEHAVIOR_SCHEMA,
    instructions: behaviorPrompt({ history: flattened, context, psychological, reaction, trustLevel, recentBehaviors: recentBehaviors.slice(-3) }),
    participantCode,
    maxOutputTokens: 350
  });

  let resistancePattern = null;
  if (behavior.behavior === "resistance") {
    const resistance = await structuredResponse(env, {
      name: "patient_act_resistance",
      schema: RESISTANCE_SCHEMA,
      instructions: resistancePrompt({ history: flattened, context, psychological, reaction, trustLevel }),
      participantCode,
      maxOutputTokens: 350
    });
    resistancePattern = resistance.pattern;
  }

  const signal = signalPrompt({ context, reaction, behavior, resistancePattern });
  const responseInput = history.map(message => ({ ...message }));
  responseInput[responseInput.length - 1].content += `\n${signal}`;
  const response = await structuredResponse(env, {
    name: "patient_act_response",
    schema: RESPONSE_SCHEMA,
    instructions: patientActSystemPrompt(caseData),
    input: responseInput,
    participantCode,
    maxOutputTokens: 500
  });

  const therapistPattern = psychological.interpersonal_patterns.find(pattern => String(pattern.domain).toLowerCase() === "the therapist");
  const trust = await structuredResponse(env, {
    name: "patient_act_trust",
    schema: TRUST_SCHEMA,
    instructions: trustPrompt({
      history: flattened,
      attachmentStyle: caseData.seed?.attachment_style || "",
      therapistExpectation: therapistPattern?.response_of_other || "unknown",
      trustLevel
    }),
    participantCode,
    maxOutputTokens: 350
  });
  const nextTrust = Math.max(1, Math.min(4, trustLevel + TRUST_DELTAS[trust.direction]));
  const nextHistory = [...history, { role: "assistant", content: String(response.content || "").trim() }];
  return {
    content: String(response.content || "").trim(),
    state: {
      ...state,
      turn: Number(state.turn || 0) + 1,
      patient_act: {
        trust_level: nextTrust,
        reaction: reaction.reaction,
        reaction_intensity: reaction.intensity,
        behavior: behavior.behavior,
        recent_behaviors: [...recentBehaviors, behavior.behavior],
        resistance_pattern: resistancePattern,
        history: nextHistory
      }
    }
  };
}
