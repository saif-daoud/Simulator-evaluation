import { pathToFileURL } from "node:url";

const REQUIRED = [
  "LLM_RELAY_BASE_URL",
  "LLM_RELAY_TOKEN",
  "EXPERT_ACCESS_CODES",
  "TOKEN_SECRET"
];

export function validateDeploymentEnvironment(env) {
  for (const name of REQUIRED) {
    if (!String(env[name] || "").trim()) throw new Error(`Required repository secret is missing: ${name}`);
  }

  let relayUrl;
  try {
    relayUrl = new URL(env.LLM_RELAY_BASE_URL);
  } catch {
    throw new Error("LLM_RELAY_BASE_URL must be a valid URL.");
  }
  if (
    relayUrl.protocol !== "https:" ||
    relayUrl.pathname.replace(/\/+$/, "") !== "/api" ||
    relayUrl.search ||
    relayUrl.hash
  ) {
    throw new Error("LLM_RELAY_BASE_URL must be an HTTPS origin ending in /api with no query or fragment.");
  }
  if (env.LLM_RELAY_BASE_URL.includes("replace-with")) {
    throw new Error("LLM_RELAY_BASE_URL still contains a placeholder.");
  }
  if (env.LLM_RELAY_TOKEN.length < 32) {
    throw new Error("LLM_RELAY_TOKEN must contain at least 32 characters.");
  }
  if (env.TOKEN_SECRET.length < 32) {
    throw new Error("TOKEN_SECRET must contain at least 32 characters.");
  }

  let accessCodes;
  try {
    accessCodes = JSON.parse(env.EXPERT_ACCESS_CODES);
  } catch {
    throw new Error("EXPERT_ACCESS_CODES must be valid JSON.");
  }
  if (!accessCodes || Array.isArray(accessCodes) || typeof accessCodes !== "object" || !Object.keys(accessCodes).length) {
    throw new Error("EXPERT_ACCESS_CODES must be a non-empty JSON object.");
  }
  for (const [participantCode, accessCode] of Object.entries(accessCodes)) {
    if (!participantCode.trim() || typeof accessCode !== "string" || !accessCode.trim()) {
      throw new Error("EXPERT_ACCESS_CODES must map participant codes to non-empty access-code strings.");
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateDeploymentEnvironment(process.env);
    console.log("Deployment environment validation passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
