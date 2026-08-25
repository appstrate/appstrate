// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The COMPLETE set of environment variables an ALIASED run's agent container
 * receives — what is in its environment before it sends anything, a surface with
 * no natural guard. Two sibling gates pin what crosses the wire afterwards
 * (`runtime-pi/test/alias-dialect-opacity.test.ts`,
 * `runtime-pi/sidecar/test/pi-messages-backend.test.ts`); the three together are the
 * security argument for the alias contract.
 *
 * The assertion is an ALLOWLIST, compared as an EXACT SET. Asserting the absence
 * of today's known-bad names would be worth nothing against tomorrow's: the next
 * leak has a name nobody has written down yet. Any key that starts reaching an
 * aliased container fails this test until someone adds it here deliberately —
 * the only moment at which the disclosure question gets asked.
 *
 * BOTH sets are pinned, aliased and non-aliased, because the security property is
 * the DIFFERENCE between them. Withholding a variable from every run would
 * satisfy a one-sided assertion while saying nothing about what an alias hides.
 *
 * The env comes from the real builder, `buildRuntimePiEnv`: `run-launcher/pi.ts`
 * hands its result straight to `orchestrator.createWorkload`, which passes
 * `spec.env` to the container verbatim. A hand-written dict would keep passing
 * after a launcher change that started leaking again.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  ALIAS_API_KEY_PLACEHOLDER,
  buildRuntimePiEnv,
  SIDECAR_OPERATOR_ENV_KEYS,
} from "../src/container-env.ts";
import type { RuntimePiEnvOptions } from "../src/container-env.ts";

/**
 * The launcher's own call shape (`apps/api/src/services/run-launcher/pi.ts`),
 * with every remaining option of the contract supplied as well.
 *
 * MAXIMAL on purpose: an option left unset is a hole in the allowlist, since a
 * key emitted behind that conditional would never appear in the pinned set and
 * could be added without failing anything. So this pins what the builder CAN
 * emit, not one production run — `agentInput` comes from the CLI / GitHub
 * Action side of the same contract.
 *
 * Sidecar-backed, because an aliased run always is: the sidecar is the only place
 * the alias→real `model` swap happens, so skipping it would hand the agent the
 * real backing id and the provider's real endpoint.
 */
const RUN: RuntimePiEnvOptions = {
  model: {
    // The REAL backing, as the launcher resolves it. Everything identifying here
    // is an input to the masking decision, not an output.
    api: "openai-completions",
    // The launcher passes the PUBLIC alias id as `modelId` for an aliased run.
    // Held constant across both calls below, so the only input that differs is the
    // flag and the output difference is therefore the alias policy itself.
    modelId: "appstrate-medium",
    baseUrl: "https://api.deepseek.com/v1",
    providerId: "deepseek",
    apiKey: "sk-real-backing-key",
    // Vendor-REVEALING on purpose. The launcher derives this with
    // `deriveKeyPlaceholder`, which preserves the key's dash-separated prefix so
    // the SDK's prefix sniffing keeps working — and for a real key that prefix
    // names the vendor. A neutral `"sk-placeholder"` here is what let
    // `MODEL_API_KEY` ship unmasked: the fixture agreed with itself on both
    // paths, so the value-diff below had nothing to catch.
    apiKeyPlaceholder: "sk-ant-api03-placeholder",
    input: ["text", "image"],
    // A real catalog pair, sent unchanged on both paths.
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    reasoningLevelMap: { high: "xhigh" },
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028 },
    aliased: true,
  },
  generation: { temperature: 0.2, reasoningLevel: "high" },
  agentPrompt: "You are a helpful agent.",
  runId: "run_1",
  agentInput: { topic: "quarterly report" },
  timeoutSeconds: 900,
  sidecarUrl: "http://sidecar:8080",
  sidecarProxyLlmUrl: "http://sidecar:8080/llm",
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  maxFileBytes: 104_857_600,
  forwardProxyUrl: "http://sidecar:8081",
  noProxy: "sidecar,localhost,127.0.0.1",
  sink: {
    url: "https://appstrate.test/api/runs/run_1/events",
    finalizeUrl: "https://appstrate.test/api/runs/run_1/events/finalize",
    secret: "abcdefghijklmnopqrstuvwxyz0123456789",
  },
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

/**
 * Everything an ALIASED run's agent container is allowed to see — a disclosure
 * inventory, not a config list. Each key is here because it carries the SAME
 * value whatever vendor backs the alias, or because its vendor-varying part has
 * been masked out of it:
 *
 * - `MODEL_API` is the canonical `pi-messages` dialect for every alias, so it
 *   names no protocol family.
 * - `MODEL_ID` is the public alias id — the caller chose it.
 * - `MODEL_BASE_URL` is the sidecar's own proxy URL and `MODEL_API_KEY` the
 *   placeholder it swaps; neither reaches upstream.
 * - `MODEL_CONTEXT_WINDOW` / `MODEL_MAX_TOKENS` are the backing's real limits,
 *   which the container needs to size compaction. They narrow the candidate set
 *   without closing it, and the exact `usage.input` count the run reports
 *   out-tells them anyway (`docs/architecture/MODEL_ALIASES.md`).
 * - `MODEL_INPUT` is the modality vector, published on purpose: withholding it
 *   would silently disable image input for the run.
 * - the rest is run plumbing (prompt, input, sink, trace, proxy, caps) whose
 *   values come from the platform and the org's own request.
 */
const ALIASED_CONTAINER_ENV_KEYS = [
  "AGENT_INPUT",
  "AGENT_PROMPT",
  "AGENT_RUN_ID",
  "AGENT_TIMEOUT_SECONDS",
  "APPSTRATE_MCP_TOOL_TIMEOUT_MS",
  "APPSTRATE_SINK_FINALIZE_URL",
  "APPSTRATE_SINK_SECRET",
  "APPSTRATE_SINK_URL",
  "FILE_MAX_BYTES",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "MODEL_API",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_ID",
  "MODEL_INPUT",
  "MODEL_MAX_TOKENS",
  "MODEL_REASONING",
  "MODEL_REASONING_LEVEL",
  "MODEL_TEMPERATURE",
  "NO_PROXY",
  "OUTPUT_SCHEMA",
  "SIDECAR_MAX_REQUEST_BODY_BYTES",
  "SIDECAR_URL",
  "TOOL_RESULT_BYTE_LIMIT",
  "TRACEPARENT",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * What a NON-aliased run gets on top: the whole of what an alias withholds, each
 * naming the backing — `MODEL_PROVIDER` is the vendor key itself,
 * `MODEL_REASONING_LEVEL_MAP` its own effort vocabulary (a fingerprint), and
 * `MODEL_COST` the published rate card, one catalog lookup from a name. A BYOK
 * model the org configured itself has nothing to hide, so it keeps all three.
 */
const ALIAS_WITHHELD_KEYS = ["MODEL_COST", "MODEL_PROVIDER", "MODEL_REASONING_LEVEL_MAP"] as const;

/**
 * Shared keys whose VALUE is masked rather than the key withheld. The key-set
 * difference alone would miss a variable that survives but starts carrying
 * something vendor-specific, so this is pinned as an exact set too.
 */
const ALIAS_MASKED_VALUE_KEYS = ["MODEL_API", "MODEL_API_KEY"] as const;

const WHY_THIS_GATE_EXISTS = [
  "",
  "Every variable in an ALIASED run's container is readable by the organization:",
  "the agent can print its own environment, and the run log is an Appstrate",
  "dashboard surface. A new key here is therefore a DISCLOSURE decision, not a",
  "plumbing detail, and has to be justified against the alias contract in",
  "docs/architecture/MODEL_ALIASES.md (“What an alias hides — and from whom”),",
  "which states what the platform may disclose and what it must not.",
  "",
  "If the value is the same whatever vendor backs the alias, add the key to",
  "ALIASED_CONTAINER_ENV_KEYS in this file and say there why it is safe. If it",
  "varies with the backing — a provider id, a rate card, an endpoint, a protocol",
  "family — withhold or mask it in buildRuntimePiEnv the way MODEL_PROVIDER,",
  "MODEL_COST and MODEL_API are, and pin it in ALIAS_WITHHELD_KEYS /",
  "ALIAS_MASKED_VALUE_KEYS instead.",
  "",
  "Updating the list without answering that question is exactly how MODEL_PROVIDER",
  "came back in #1196 and went unnoticed for a release.",
].join("\n");

/**
 * Exact-set comparison reporting drift in both directions, and what to do about
 * it. `toEqual` on two sorted arrays reports only “expected A to equal B”, which
 * sends the next engineer to update the fixture without asking the question this
 * gate exists to force.
 */
function expectExactKeySet(actual: readonly string[], expected: readonly string[], what: string) {
  const unexpected = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new Error(
    [
      `${what} drifted from the pinned allowlist.`,
      "",
      `  reached the container, not on the list: ${unexpected.join(", ") || "(none)"}`,
      `  on the list, no longer emitted:         ${missing.join(", ") || "(none)"}`,
      WHY_THIS_GATE_EXISTS,
    ].join("\n"),
  );
}

/**
 * The knobs `buildRuntimePiEnv` reads from the HOST's `process.env` rather than
 * from its options. All of them are set here, from the exported list rather than
 * the two the builder forwards today, so that widening the forwarded subset also
 * trips this gate: left ambient, a newly forwarded knob would just be absent on a
 * machine that does not set it, and the gate would pass while the container
 * gained a variable.
 *
 * `LOG_LEVEL` gets a real level rather than the uniform `"1"`: pino throws on an
 * unknown one, and this key is read at module scope by anything building a logger
 * while it is set.
 */
const HOST_ENV_KEYS = [...SIDECAR_OPERATOR_ENV_KEYS, "TOOL_RESULT_BYTE_LIMIT"] as const;
const originalHostEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of HOST_ENV_KEYS) {
    originalHostEnv[key] = process.env[key];
    process.env[key] = key === "LOG_LEVEL" ? "info" : "1";
  }
});

afterEach(() => {
  for (const key of HOST_ENV_KEYS) {
    const original = originalHostEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("aliased agent container env — exact allowlist (issue #1198, Threat B)", () => {
  const aliasedEnv = () => buildRuntimePiEnv({ ...RUN, model: { ...RUN.model, aliased: true } });
  const byokEnv = () => buildRuntimePiEnv({ ...RUN, model: { ...RUN.model, aliased: false } });

  it("gives an aliased container exactly the allowlisted variables and nothing else", () => {
    expectExactKeySet(
      Object.keys(aliasedEnv()).sort(),
      [...ALIASED_CONTAINER_ENV_KEYS].sort(),
      "An ALIASED run's agent container env",
    );
  });

  it("gives a non-aliased container the allowlist plus the three withheld from an alias", () => {
    // Pinned so the gate states a DIFFERENCE: without this side, withholding a
    // variable from every run would leave the aliased assertion green.
    expectExactKeySet(
      Object.keys(byokEnv()).sort(),
      [...ALIASED_CONTAINER_ENV_KEYS, ...ALIAS_WITHHELD_KEYS].sort(),
      "A NON-aliased run's agent container env",
    );
  });

  it("states the difference: three keys withheld, none added", () => {
    const aliased = Object.keys(aliasedEnv());
    const byok = Object.keys(byokEnv());

    expect(byok.filter((key) => !aliased.includes(key)).sort()).toEqual(
      [...ALIAS_WITHHELD_KEYS].sort(),
    );
    // An alias may only ever REMOVE from the container's environment: a key
    // present only for an alias exists *because* the model is aliased, which is
    // itself the tell.
    expect(aliased.filter((key) => !byok.includes(key))).toEqual([]);
  });

  it("masks the value of the keys it does not withhold outright", () => {
    const aliased = aliasedEnv();
    const byok = byokEnv();
    const shared = Object.keys(aliased).filter((key) => key in byok);

    expectExactKeySet(
      shared.filter((key) => aliased[key] !== byok[key]).sort(),
      [...ALIAS_MASKED_VALUE_KEYS].sort(),
      "The set of shared keys whose value an alias masks",
    );

    // The canonical dialect in place of the backing's protocol family.
    expect(aliased.MODEL_API).toBe("pi-messages");
    expect(byok.MODEL_API).toBe("openai-completions");
    // The credential placeholder is a vendor tell in exactly the same way, and
    // was the one that shipped: the launcher's placeholder keeps the key's
    // prefix, so `sk-ant-…` / `sk-proj-…` / `sk-or-v1-…` names the backing to
    // code that can read its own environment. An alias gets a constant instead;
    // `pi-messages` authenticates with `Authorization: Bearer` and never reads
    // the value's shape. BYOK keeps the derived one — that container is told its
    // provider outright via MODEL_PROVIDER anyway.
    expect(aliased.MODEL_API_KEY).toBe(ALIAS_API_KEY_PLACEHOLDER);
    expect(aliased.MODEL_API_KEY).not.toContain("ant");
    expect(byok.MODEL_API_KEY).toBe("sk-ant-api03-placeholder");
    // Neither path ever carries the real upstream credential.
    expect(aliased.MODEL_API_KEY).not.toContain("real-backing-key");
    expect(byok.MODEL_API_KEY).not.toContain("real-backing-key");
    // The token limits are NOT masked: both paths carry the real numbers.
    expect(aliased.MODEL_CONTEXT_WINDOW).toBe(byok.MODEL_CONTEXT_WINDOW);
    expect(aliased.MODEL_MAX_TOKENS).toBe(byok.MODEL_MAX_TOKENS);
    expect(aliased.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(aliased.MODEL_MAX_TOKENS).toBe("64000");
  });
});
