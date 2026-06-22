// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the provider → execution-engine binding.
 *
 * A model provider runs on one of three engines: the generic `pi` loop (every
 * API-key provider), or one of the two ToS-clean subscription engines that
 * drive the vendor's OFFICIAL binary so it signs its own client fingerprint —
 * `claude` (Claude Agent SDK, for the `claude-code` subscription) and `codex`
 * (Codex CLI, for the `codex` subscription). There is deliberately no
 * fingerprint-forging fallback: a subscription with no such engine is rejected,
 * never forged.
 *
 * Both axes — agent **runs** (run-launcher) and **chat** (module-chat) — and the
 * llm-proxy subscription gateways read this one mapping, so the "which provider
 * runs on which engine" decision (and the codex egress allowlist + the
 * human-facing label) cannot drift between them.
 */

/** The execution engine for a resolved model. */
export type RunEngine = "pi" | "claude" | "codex";

/** A subscription engine — one that drives a vendor's official binary. */
export type SubscriptionRunEngine = Exclude<RunEngine, "pi">;

export interface SubscriptionEngineDef {
  /** Credential provider id (e.g. `"claude-code"`, `"codex"`). */
  providerId: string;
  /** Engine that drives this provider's official binary. */
  engine: SubscriptionRunEngine;
  /** Human-readable provider name for user-facing messages. */
  label: string;
  /**
   * How the sidecar delivers the subscription credential to the run:
   *
   * - `"oauth"` — the official binary points at the sidecar's `/llm` gateway,
   *   which swaps the placeholder bearer for the real token server-side. The
   *   real token never enters the agent container, so egress need not be locked.
   * - `"vend"` — the binary talks to the upstream DIRECTLY (it ignores any
   *   base-URL override), so the sidecar cannot reverse-proxy it. The runner
   *   GETs the real token once from `/credential-vend` into the container; the
   *   real token therefore lives in-container and its egress MUST be locked to
   *   the vendor's hosts ({@link egressAllowlist}) as the sole compensating
   *   control.
   *
   * Invariant: `sidecarAuthMode === "vend"` iff {@link egressAllowlist} is set.
   */
  sidecarAuthMode: "oauth" | "vend";
  /**
   * Per-run egress allowlist for `"vend"` engines that hold the REAL token
   * in-container (suffix-matched). Required for vend, absent for oauth.
   */
  egressAllowlist?: readonly string[];
  /**
   * True iff this engine materialises the structured deliverable NATIVELY (its
   * binary emits `output` directly — e.g. the Claude SDK's `outputFormat` →
   * `structured_output`) rather than via the platform's MCP `output` runtime
   * tool. When set, the launcher MUST NOT serve the MCP `output` tool to the
   * run (two output mechanisms would be ambiguous and could double-emit); the
   * output JSON Schema still reaches the runner for the native path. Engines
   * without this capability (codex, pi) take `output` through the MCP tool.
   */
  nativeOutput?: boolean;
}

/**
 * The subscription engines. Adding a new ToS-clean subscription provider is one
 * entry here, paired with its gateway + engine implementation.
 */
export const SUBSCRIPTION_ENGINES: readonly SubscriptionEngineDef[] = [
  // Claude Agent SDK: the sidecar `/llm` gateway swaps the bearer server-side,
  // so the real token never enters the container — no egress lock needed.
  {
    providerId: "claude-code",
    engine: "claude",
    label: "Claude Code",
    sidecarAuthMode: "oauth",
    // The Claude SDK emits the structured deliverable via `outputFormat` →
    // `structured_output`; the run must not also be offered the MCP `output`.
    nativeOutput: true,
  },
  {
    providerId: "codex",
    engine: "codex",
    label: "Codex",
    // The Codex CLI holds the real token in-container (it ignores
    // `chatgpt_base_url` and talks to chatgpt.com directly), so the token is
    // vended into the container and its egress is locked to OpenAI's hosts only
    // — `chatgpt.com` (backend) + `openai.com` (auth/api, suffix-matched).
    // Everything else is refused.
    sidecarAuthMode: "vend",
    egressAllowlist: ["chatgpt.com", "openai.com"],
  },
] as const;

const BY_PROVIDER = new Map<string, SubscriptionEngineDef>(
  SUBSCRIPTION_ENGINES.map((def) => [def.providerId, def]),
);

/**
 * The engine for a provider id: its subscription engine, or `"pi"` for every
 * API-key provider. Pure.
 */
export function engineForProvider(providerId: string): RunEngine {
  return BY_PROVIDER.get(providerId)?.engine ?? "pi";
}

/** The subscription-engine definition for a provider id, or `undefined`. Pure. */
export function subscriptionEngineDef(providerId: string): SubscriptionEngineDef | undefined {
  return BY_PROVIDER.get(providerId);
}

/** True iff `engine` is a subscription engine (drives a vendor's official binary). */
export function isSubscriptionEngine(engine: RunEngine): engine is SubscriptionRunEngine {
  return engine !== "pi";
}

const NATIVE_OUTPUT_ENGINES = new Set<RunEngine>(
  SUBSCRIPTION_ENGINES.filter((d) => d.nativeOutput).map((d) => d.engine),
);

/**
 * True iff `engine` materialises the structured deliverable natively (see
 * {@link SubscriptionEngineDef.nativeOutput}). The launcher uses this to decide
 * whether to serve the MCP `output` runtime tool to a run — native-output
 * engines must not be offered it. Pure; `"pi"` is always false.
 */
export function engineHasNativeOutput(engine: RunEngine): boolean {
  return NATIVE_OUTPUT_ENGINES.has(engine);
}
