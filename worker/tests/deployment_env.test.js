import test from "node:test";
import assert from "node:assert/strict";

import { validateDeploymentEnvironment } from "../scripts/validate-deployment-env.mjs";

const VALID_ENV = {
  LLM_RELAY_BASE_URL: "https://relay-example.ngrok-free.dev/api",
  LLM_RELAY_TOKEN: "r".repeat(32),
  EXPERT_ACCESS_CODES: JSON.stringify({ "EXPERT-TEST": "test-code" }),
  TOKEN_SECRET: "t".repeat(32)
};

test("deployment environment accepts a complete standalone relay configuration", () => {
  assert.equal(validateDeploymentEnvironment(VALID_ENV), true);
});

test("deployment environment rejects missing and placeholder relay settings", () => {
  assert.throws(
    () => validateDeploymentEnvironment({ ...VALID_ENV, LLM_RELAY_BASE_URL: "" }),
    /LLM_RELAY_BASE_URL/
  );
  assert.throws(
    () => validateDeploymentEnvironment({
      ...VALID_ENV,
      LLM_RELAY_BASE_URL: "https://replace-with-domain.ngrok-free.dev/api"
    }),
    /placeholder/
  );
  assert.throws(
    () => validateDeploymentEnvironment({ ...VALID_ENV, LLM_RELAY_TOKEN: "short" }),
    /at least 32/
  );
});

test("deployment environment validates expert codes and signing secret", () => {
  assert.throws(
    () => validateDeploymentEnvironment({ ...VALID_ENV, EXPERT_ACCESS_CODES: "not-json" }),
    /valid JSON/
  );
  assert.throws(
    () => validateDeploymentEnvironment({ ...VALID_ENV, EXPERT_ACCESS_CODES: "{}" }),
    /non-empty JSON object/
  );
  assert.throws(
    () => validateDeploymentEnvironment({ ...VALID_ENV, TOKEN_SECRET: "short" }),
    /at least 32/
  );
});
