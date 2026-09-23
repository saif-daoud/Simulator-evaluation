import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sourcePath = path.resolve(projectRoot, "source-data/patient_profiles.json");
const outputPath = path.resolve(projectRoot, "worker/src/profiles.js");

const existingIds = [
  "patient_act_001", "patient_act_002", "patient_act_003", "patient_act_021", "patient_act_022",
  "patient_act_004", "patient_act_007", "patient_act_016", "patient_act_023", "patient_act_026"
];

const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const byId = new Map(raw.map(item => [item.profile_id, item]));
const selectedIds = [
  ...existingIds,
  ...raw
    .map(item => item.profile_id)
    .filter(id => !existingIds.includes(id))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
];

if (selectedIds.length !== 40 || new Set(selectedIds).size !== 40) {
  throw new Error(`Expected 40 unique patient profiles, found ${selectedIds.length}`);
}

function clean(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function conditionLabel(value) {
  const key = Array.isArray(value) ? value[0] : value;
  return ({ anxiety_disorder: "Anxiety disorder", depression: "Depression" })[key]
    || clean(key).replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function firstSentence(text, max = 155) {
  const sentence = clean(text).split(/(?<=[.!?])\s/, 1)[0];
  return sentence.length <= max ? sentence : `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

const profiles = selectedIds.map((id, index) => {
  const item = byId.get(id);
  if (!item) throw new Error(`Missing source profile: ${id}`);
  const profile = item.profile || {};
  const formulation = profile.psychological_formulation || {};
  return {
    id: `case-${String(index + 1).padStart(2, "0")}`,
    source_id: id,
    display_number: index + 1,
    display_name: `Patient ${String(index + 1).padStart(2, "0")}`,
    condition: conditionLabel(item.disease_key || item.presenting_conditions),
    short_description: firstSentence(item.summary),
    summary: clean(item.summary),
    current_context: clean(item.current_stressor),
    relevant_history: clean(item.relevant_history),
    coping_strategies: (item.coping_strategies || []).map(clean).filter(Boolean),
    prompt_profile: {
      demographics: profile.demographics || item.seed?.demographics || {},
      presenting_conditions: item.presenting_conditions || [],
      summary: clean(item.summary),
      relevant_history: clean(item.relevant_history),
      core_beliefs: item.core_beliefs || formulation.core_beliefs || [],
      intermediate_beliefs: item.intermediate_beliefs || formulation.intermediate_beliefs || [],
      automatic_thoughts: formulation.automatic_thoughts || [],
      triggers: formulation.triggers || [],
      coping_strategies: item.coping_strategies || formulation.coping_patterns || [],
      emotional_range: clean(formulation.emotional_range),
      interpersonal_patterns: formulation.interpersonal_patterns || [],
      current_stressor: clean(item.current_stressor),
      conversational_style: clean(item.conversational_style || "plain"),
      attachment_style: clean(item.seed?.attachment_style),
      memory: (item.memory?.items || []).map(memory => ({
        content: clean(memory.content),
        disclosure_level: Number(memory.disclosure_level),
        activation_tags: memory.activation_tags || [],
        generates_discomfort: Boolean(memory.generates_discomfort)
      })),
      patient_act_case: {
        profile: item.profile,
        memory: item.memory,
        seed: item.seed
      }
    }
  };
});

const banner = "// Generated from the bundled source-data/patient_profiles.json by scripts/generate_profiles.mjs.\n// Re-run the generator after intentional source-profile updates.\n";
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${banner}export const PROFILES = ${JSON.stringify(profiles, null, 2)};\n`, "utf8");
console.log(`Wrote ${profiles.length} profiles to ${outputPath}`);
