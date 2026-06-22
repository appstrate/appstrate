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
   * Per-run egress allowlist for engines that hold the REAL subscription token
   * in-container (the binary talks to the upstream directly, so its outbound
   * traffic must be locked to the vendor's hosts — suffix-matched). Absent when
   * the engine never exposes the real token to the sandbox (e.g. the Claude
   * Agent SDK, whose token is swapped server-side by the gateway).
   */
  egressAllowlist?: readonly string[];
}

/**
 * The subscription engines. Adding a new ToS-clean subscription provider is one
 * entry here, paired with its gateway + engine implementation.
 */
export const SUBSCRIPTION_ENGINES: readonly SubscriptionEngineDef[] = [
  { providerId: "claude-code", engine: "claude", label: "Claude Code" },
  {
    providerId: "codex",
    engine: "codex",
    label: "Codex",
    // The Codex CLI holds the real token in-container (it ignores
    // `chatgpt_base_url` and talks to chatgpt.com directly), so its egress is
    // locked to OpenAI's hosts only — `chatgpt.com` (backend) + `openai.com`
    // (auth/api, suffix-matched). Everything else is refused.
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
