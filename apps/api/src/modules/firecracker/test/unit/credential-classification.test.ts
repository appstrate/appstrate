// SPDX-License-Identifier: Apache-2.0

/**
 * Credential classification coverage (prod-gaps B5, SEC).
 *
 * The MMDS broker (credential-split.ts) moves KNOWN-SECRET sidecar/agent
 * env keys off the at-rest config drive. The failure mode this test guards
 * against: someone adds a new secret-bearing key to the sidecar env
 * builders (services/orchestrator/sidecar-env.ts) and forgets to classify
 * it in SIDECAR_SECRET_KEYS — the secret then lands on the config drive at
 * rest, silently.
 *
 * Mechanism: build the sidecar env from fully-populated launch specs
 * (every optional branch exercised, both LLM auth modes), collect the
 * union of emitted keys, and FAIL if any key is neither a known secret nor
 * explicitly classified non-secret below. Adding an env key to the
 * builders forces the author to make a conscious classification decision.
 */

import { describe, it, expect } from "bun:test";
import type {
  SidecarLaunchSpec,
  IntegrationSpawnSpec,
  LlmProxyConfig,
} from "@appstrate/core/sidecar-types";
import { SIDECAR_SECRET_KEYS, AGENT_SECRET_KEYS } from "../../credential-split.ts";
import { buildBaseSidecarEnv } from "../../../../services/orchestrator/sidecar-env.ts";

/**
 * Every sidecar env key the builders can emit that is NOT a secret.
 * Each entry needs a rationale — if you can't write one, the key is a
 * secret and belongs in SIDECAR_SECRET_KEYS instead.
 */
const CLASSIFIED_NON_SECRET: readonly string[] = [
  // Listen ports — plain configuration.
  "PORT",
  "FORWARD_PROXY_PORT",
  // Run identifier — an opaque id, not a credential.
  "RUN_ID",
  // Platform base URL — reachable-address configuration, no credential.
  "PLATFORM_API_URL",
  // Workspace handle (volume name / host path) — resource locator, no credential.
  "WORKSPACE_HANDLE_JSON",
  // Model context window — a number, plain configuration.
  "MODEL_CONTEXT_WINDOW",
  // Model max tokens — a number, plain configuration.
  "MODEL_MAX_TOKENS",
  // The model's own endpoint — an address, not a credential (platform mode holds none).
  "PI_BASE_URL",
  // Backing model ids (alias↔real) — a masking concern, not a credential.
  "PI_MODEL_SWAP_JSON",
  // Api shape of the platform llm-proxy route — a protocol name; the sidecar
  // authenticates there with RUN_TOKEN.
  "PI_LLM_PLATFORM_API_SHAPE",
  // Selected runtime tool names (output/log/note/…) — plain configuration.
  "RUNTIME_TOOLS_JSON",
  // Agent output JSON Schema — declared structure, no credential.
  "OUTPUT_SCHEMA",
  // Integration runtime adapter selector (docker/process) — layered by each
  // orchestrator after the base build; plain configuration.
  "INTEGRATION_RUNTIME_ADAPTER",
  // Operator-trusted internal egress hostnames (comma list, forwarded from the
  // platform's EGRESS_ALLOW_INTERNAL_HOSTS) — network policy, no credential.
  "EGRESS_ALLOW_INTERNAL_HOSTS",
];

/** Minimal but structurally valid integration spawn spec. */
const integrationSpec: IntegrationSpawnSpec = {
  integrationId: "@appstrate/gmail",
  namespace: "gmail",
  sourceKind: "none",
  manifest: { name: "@appstrate/gmail", version: "1.0.0" },
  // Live credentials ride here in production — exactly why the enclosing
  // INTEGRATIONS_TO_SPAWN_JSON key is classified secret.
  spawnEnv: { GMAIL_TOKEN: "secret" },
};

/** Spec fields common to both auth-mode variants — every optional branch set. */
function buildSpec(llm: LlmProxyConfig): SidecarLaunchSpec {
  return {
    runToken: "run-token",
    sidecarAuthToken: "sidecar-auth-token",
    proxyUrl: "http://user:pass@proxy.example:8080",
    llm,
    modelContextWindow: 200_000,
    modelMaxTokens: 8_192,
    integrations: [integrationSpec],
    runtimeTools: ["output", "log"],
    outputSchema: { type: "object" },
    connectLoginSpec: integrationSpec,
  };
}

// No modelSwap: the oauth mode is a pure bearer-swap (aliases are rejected
// for oauth-subscription providers platform-side).
const oauthSpec = buildSpec({
  authMode: "oauth",
  baseUrl: "https://api.anthropic.com",
  credentialId: "cred_1",
});

const platformSpec = buildSpec({
  authMode: "platform",
  apiShape: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  modelSwap: {
    alias: "public-alias",
    real: "real-model-id",
    clientApiShape: "pi-messages" as const,
    backingApiShape: "openai-completions" as const,
    backing: { providerId: "openai", reasoning: false, input: ["text"] },
  },
});

function emittedKeys(spec: SidecarLaunchSpec): string[] {
  return Object.keys(
    buildBaseSidecarEnv({
      spec,
      baseEnv: {},
      port: "8080",
      forwardProxyPort: "8081",
      runId: "run_test",
      platformApiUrl: "http://10.0.0.1:3000",
      workspace: { kind: "directory", path: "/tmp/ws" },
    }),
  );
}

describe("sidecar env key classification (MMDS broker coverage)", () => {
  const allEmitted = new Set<string>([
    ...emittedKeys(oauthSpec),
    ...emittedKeys(platformSpec),
    // Orchestrator-local — layered after the base build (see sidecar-env.ts
    // module doc), so the builders never emit it; include it by hand.
    "INTEGRATION_RUNTIME_ADAPTER",
  ]);

  it("classifies every emitted sidecar env key as secret or explicitly non-secret", () => {
    const classified = new Set([...SIDECAR_SECRET_KEYS, ...CLASSIFIED_NON_SECRET]);
    const offending = [...allEmitted].filter((key) => !classified.has(key));
    if (offending.length > 0) {
      throw new Error(
        `new sidecar env key(s) ${offending.join(", ")} are unclassified — add each to ` +
          `SIDECAR_SECRET_KEYS in credential-split.ts if it can carry a secret, else to ` +
          `CLASSIFIED_NON_SECRET here, with rationale`,
      );
    }
    expect(offending).toEqual([]);
  });

  it("has no dead CLASSIFIED_NON_SECRET entries (every entry is actually emittable)", () => {
    const dead = CLASSIFIED_NON_SECRET.filter((key) => !allEmitted.has(key));
    expect(dead).toEqual([]);
  });

  it("keeps every SIDECAR_SECRET_KEYS entry emittable by the builders (no dead/renamed secrets)", () => {
    // A secret key the builders can no longer emit means the broker list
    // drifted from the env builders (rename without updating the split).
    const dead = SIDECAR_SECRET_KEYS.filter((key) => !allEmitted.has(key));
    expect(dead).toEqual([]);
    // Pin the exact expected set so a silent shrink is also caught.
    expect([...SIDECAR_SECRET_KEYS].sort()).toEqual([
      "CONNECT_LOGIN_JSON",
      "INTEGRATIONS_TO_SPAWN_JSON",
      "PI_LLM_OAUTH_CONFIG_JSON",
      "PROXY_URL",
      "RUN_TOKEN",
      "SIDECAR_AUTH_TOKEN",
    ]);
  });

  it("emits the oauth secret only on the oauth branch", () => {
    expect(new Set(emittedKeys(oauthSpec)).has("PI_LLM_OAUTH_CONFIG_JSON")).toBe(true);
    expect(new Set(emittedKeys(platformSpec)).has("PI_LLM_OAUTH_CONFIG_JSON")).toBe(false);
  });
});

describe("agent env key classification", () => {
  it("pins AGENT_SECRET_KEYS to the sink secret, the model key and the sidecar bearer", () => {
    // The agent env is built by buildRuntimePiEnv
    // (services/run-launcher/pi.ts). If it grows another secret-bearing
    // key, the author must add it to AGENT_SECRET_KEYS in
    // credential-split.ts AND update this pin consciously.
    expect([...AGENT_SECRET_KEYS].sort()).toEqual([
      "APPSTRATE_SINK_SECRET",
      "MODEL_API_KEY",
      "SIDECAR_AUTH_TOKEN",
    ]);
  });
});
