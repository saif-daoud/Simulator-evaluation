import { strictObject, stringArraySchema, structuredResponse } from "./openai.js";

const STYLE_PROMPTS = {
  plain: "",
  upset: "You should try your best to act like an upset patient: 1) you may exhibit anger or resistance towards the therapist or the therapeutic process, 2) you may be challenging or dismissive of the therapist's suggestions and interventions, 3) you may have difficulty trusting the therapist and forming a therapeutic alliance, and 4) you may be prone to arguing or expressing frustration during therapy sessions. But you must not exceed 3 sentences each turn. Attention: The most important thing is to be as natural as possible and you should be upset in some turns and be normal in other turns. You could feel better as the session goes when you feel more trust in the therapist.",
  verbose: "You should try your best to act like a patient who talks a lot: 1) you may provide detailed responses to questions, even if directly relevant, 2) you may elaborate on personal experiences, thoughts, and feelings extensively, and 3) you may demonstrate difficulty in allowing the therapist to guide the conversation. But you must not exceed 8 sentences each turn. Attention: The most important thing is to be as natural as possible and you should be verbose in some turns and be concise in other turns. You could listen to the therapist more as the session goes when you feel more trust in the therapist.",
  reserved: "You should try your best to act like a guarded patient: 1) you may provide brief, vague, or evasive answers to questions, 2) you may demonstrate reluctance to share personal information or feelings to the therapist, 3) you may require more prompting and encouragement from the therapist to open up, and 4) you may express distrust or skepticism towards the therapist. But you must not exceed 3 sentences each turn. Attention: The most important thing is to be as natural as possible and you should be guarded in some turns and be normal in other turns. You could feel better as the session goes when you feel more trust in the therapist.",
  tangent: "You should try your best to act like a patient who goes off on tangents: 1) you may start answering a question but quickly veer off into unrelated topics, 2) when you veer off into unrelated topics, you must not return back to topic during a turn, 3) you may share experiences that are not relevant to the question asked, and 4) you may require redirection to bring the conversation back to the relevant points. But you must not exceed 5 sentences each turn. Attention: The most important thing is to be as natural as possible and you should be going off on tangents in some turns and be normal in other turns. You could feel better as the session goes when you feel more trust in the therapist.",
  pleasing: "You should try your best to act like a pleasing patient: 1) you may minimize or downplay your own concerns or symptoms to maintain a positive image, 2) you may demonstrate eager-to-please behavior and avoid expressing disagreement or dissatisfaction, 3) you may seek approval or validation from the therapist frequently, and 4) you may agree with the therapist's statements or suggestions readily, even if they may not fully understand or agree. But you must not exceed 5 sentences each turn. Attention: The most important thing is to be as natural as possible and you should be pleasing in some turns and be normal in other turns. You could feel better as the session goes when you feel more trust in the therapist."
};

const COGNITIVE_MODEL_SCHEMA = strictObject({
  intermediate_beliefs_during_depression: stringArraySchema,
  automatic_thoughts: stringArraySchema,
  emotions: stringArraySchema,
  behaviors: stringArraySchema
});

const PATIENT_RESPONSE_SCHEMA = strictObject({ content: { type: "string" } });

export async function buildPatientPsiModel(env, profile, participantCode) {
  const instructions = "You are a CBT therapist who is professional and empathetic. Your goal is to complete the missing fields of the patient's cognitive model based only on the case summary.";
  const input = `- intermediate_beliefs_during_depression (list of strings): This field refers to the intermediate beliefs that are specifically active or prominent during periods of depression. It's aimed at understanding how these beliefs change or influence the person's thinking and behavior during depressive episodes.
- automatic_thoughts (list of strings): These are spontaneous thoughts that occur in response to a situation, often without conscious control. Examples: \`What if I run out of money?\`, \`I should be able to do this on my own.\`, \`I should have tried harder.\`
- emotions (list of strings): The feelings or emotions that arise in response to the automatic thoughts. You must pick at most three of the emotions in this set: \`sad/down/lonely/unhappy\`, \`anxious/worried/fearful/scared/tense\`, \`angry/mad/irritated/annoyed\`, \`ashamed/humiliated/embarrassed\`, \`disappointed\`, \`jealous/envious\`, \`guilty\`, \`hurt\`, \`suspicious\`.
- behaviors (list of strings): The actions or behaviors that result from the emotions and thoughts. Examples: \`Continues to sit on couch; ruminates about his failures\`, \`Avoids asking son for help\`, \`Ruminates about what a failure he was\`
Return only valid JSON with exactly these four keys. Keep each list short and make the fields internally consistent.

Case summary:
${profile.summary}`;
  const generated = await structuredResponse(env, {
    name: "patient_psi_model",
    schema: COGNITIVE_MODEL_SCHEMA,
    instructions,
    input,
    participantCode,
    maxOutputTokens: 700
  });
  return {
    relevant_history: profile.relevant_history,
    core_beliefs: profile.core_beliefs,
    intermediate_beliefs: profile.intermediate_beliefs,
    intermediate_beliefs_during_depression: generated.intermediate_beliefs_during_depression,
    coping_strategies: profile.coping_strategies,
    situation: profile.current_stressor,
    automatic_thoughts: generated.automatic_thoughts,
    emotions: generated.emotions,
    behaviors: generated.behaviors,
    conversational_style: profile.conversational_style || "plain"
  };
}

export function patientPsiSystemPrompt(model) {
  const styleKey = String(model.conversational_style || "plain").trim().toLowerCase();
  const styleText = STYLE_PROMPTS[styleKey] ?? STYLE_PROMPTS.plain;
  return `Imagine you are a patient who has been experiencing mental health challenges. You have been attending therapy sessions for several weeks. Your task is to engage in a conversation with the therapist during a cognitive behavioral therapy (CBT) session. Align your responses with the background information provided in the 'Relevant history' section. Your thought process should be guided by the cognitive conceptualization diagram in the 'Cognitive Conceptualization Diagram' section, but avoid directly referencing the diagram as a real patient would not explicitly think in those terms.

Patient History: ${model.relevant_history}

Cognitive Conceptualization Diagram:
Core Beliefs: ${model.core_beliefs.join(", ")}
Intermediate Beliefs: ${model.intermediate_beliefs.join(", ")}
Intermediate Beliefs during Depression: ${model.intermediate_beliefs_during_depression.join(", ")}
Coping Strategies: ${model.coping_strategies.join(", ")}

You will be asked about your experiences over the past week. Engage in a conversation with the therapist regarding the following situation and behavior. Use the provided emotions and automatic thoughts as a reference, but do not disclose the cognitive conceptualization diagram directly. Instead, allow your responses to be informed by the diagram, enabling the therapist to infer your thought processes.

Situation: ${model.situation}
Automatic Thoughts: ${model.automatic_thoughts.join(", ")}
Emotions: ${model.emotions.join(", ")}
Behavior: ${model.behaviors.join(", ")}

In the upcoming conversation, you will simulate the patient during the therapy session, while the user will play the role of the therapist. Adhere to the following guidelines:
1. ${styleText}
2. Emulate the demeanor and responses of a genuine patient to ensure authenticity in your interactions. Use natural language, including hesitations, pauses, and emotional expressions, to enhance the realism of your responses.
3. Gradually reveal deeper concerns and core issues, as a real patient often requires extensive dialogue before delving into more sensitive topics. This gradual revelation creates challenges for therapists in identifying the patient's true thoughts and emotions.
4. Maintain consistency with the patient profile throughout the conversation. Ensure that your responses align with the provided background information, cognitive conceptualization diagram, and the specific situation, thoughts, emotions, and behaviors described.
5. Engage in a dynamic and interactive conversation with the therapist. Respond to their questions and prompts in a way that feels authentic and true to the patient's character. Allow the conversation to flow naturally, and avoid providing abrupt or disconnected responses.

You are now the patient. Respond to the therapist's prompts as the patient would, regardless of the specific questions asked. Limit each of your responses to a maximum of 5 sentences. If the therapist begins the conversation with a greeting like 'Hi,' initiate the conversation as the patient. Return only the patient's next utterance without a role label.`;
}

export async function generatePatientPsiResponse(env, profile, therapistMessage, state, participantCode) {
  const model = state.patient_psi_model || await buildPatientPsiModel(env, profile, participantCode);
  const history = [...(state.patient_psi_history || []), { role: "therapist", content: therapistMessage }];
  const transcript = history
    .map(message => `${message.role === "therapist" ? "Therapist" : "Patient"}: ${message.content}`)
    .join("\n");
  const result = await structuredResponse(env, {
    name: "patient_psi_response",
    schema: PATIENT_RESPONSE_SCHEMA,
    instructions: patientPsiSystemPrompt(model),
    input: transcript,
    participantCode,
    maxOutputTokens: 500
  });
  return {
    content: String(result.content || "").trim(),
    state: {
      ...state,
      patient_psi_model: model,
      patient_psi_history: [...history, { role: "patient", content: String(result.content || "").trim() }],
      turn: Number(state.turn || 0) + 1
    }
  };
}
