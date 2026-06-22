// SPDX-License-Identifier: Apache-2.0

/**
 * Provider → execution-engine binding — a CONTRIBUTED registry.
 *
 * A model provider runs on one of three engines: the generic `pi` loop (every
 * API-key provider, and the default for anything unregistered), or a
 * subscription engine that drives a vendor's OFFICIAL binary so it signs its
 * own client fingerprint (no forging). Core ships ZERO subscription bindings:
 * the `claude` (Claude Agent SDK) and `codex` (Codex CLI) bindings are
 * contributed at boot by their opt-in provider modules (`@appstrate/module-
 * claude-code`, `@appstrate/module-codex`) via the `subscriptionEngine` field
 * on their {@link ModelProviderDefinition}. With those modules absent (the OSS
 * default), this registry stays empty and every provider resolves to `"pi"` —
 * core carries no subscription-engine machinery.
 *
 * Both axes — agent **runs** (run-launcher) and **chat** (module-chat) — and the
 * llm-proxy subscription gateways read this one registry by provider id, so the
 * "which provider runs on which engine" decision (plus the egress allowlist +
 * the human-facing label) cannot drift between them.
 *
 * Population is idempotent and happens once at boot, driven by
 * `registerModelProvider` (apps/api): when a provider definition carries a
 * `subscriptionEngine` binding, the platform registers it here. Tests that
 * exercise the read functions in isolation seed the registry directly via
 * {@link registerSubscriptionEngine} and clear it with
 * {@link resetSubscriptionEnginesForTesting}.
 */

/** The execution engine for a resolved model. */
export type RunEngine = "pi" | "claude" | "codex";

/** A subscription engine — one that drives a vendor's official binary. */
export type SubscriptionRunEngine = Exclude<RunEngine, "pi">;

/**
 * The engine binding a provider module contributes (on its
 * {@link ModelProviderDefinition.subscriptionEngine}). Carries no provider id /
 * label — those come from the provider definition itself at registration.
 */
export interface SubscriptionEngineBinding {
  /** Engine that drives this provider's official binary. */
  engine: SubscriptionRunEngine;
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

/** A registered binding plus the identity (provider id + label) it was registered under. */
export interface SubscriptionEngineDef extends SubscriptionEngineBinding {
  /** Credential provider id (e.g. `"claude-code"`, `"codex"`). */
  providerId: string;
  /** Human-readable provider name for user-facing messages. */
  label: string;
}

const BY_PROVIDER = new Map<string, SubscriptionEngineDef>();

/**
 * Contribute a subscription-engine binding for a provider. Idempotent for an
 * identical re-registration (same engine) so boot can run more than once in a
 * single process; throws on a CONFLICTING re-registration (same provider id,
 * different engine) — that would mean two modules disagree on a provider's
 * engine, exactly the drift this single registry exists to prevent.
 */
export function registerSubscriptionEngine(def: SubscriptionEngineDef): void {
  const existing = BY_PROVIDER.get(def.providerId);
  if (existing && existing.engine !== def.engine) {
    throw new Error(
      `Subscription engine for provider ${JSON.stringify(def.providerId)} is already ` +
        `registered as ${JSON.stringify(existing.engine)} — cannot re-register as ` +
        `${JSON.stringify(def.engine)}. Two modules disagree on this provider's engine.`,
    );
  }
  BY_PROVIDER.set(def.providerId, def);
}

/** Clear all contributed bindings. Test-only — never call in production code. */
export function resetSubscriptionEnginesForTesting(): void {
  BY_PROVIDER.clear();
}

/**
 * The engine for a provider id: its contributed subscription engine, or `"pi"`
 * for every API-key / unregistered provider. Pure read.
 */
export function engineForProvider(providerId: string): RunEngine {
  return BY_PROVIDER.get(providerId)?.engine ?? "pi";
}

/** The subscription-engine definition for a provider id, or `undefined`. Pure read. */
export function subscriptionEngineDef(providerId: string): SubscriptionEngineDef | undefined {
  return BY_PROVIDER.get(providerId);
}

/** True iff `engine` is a subscription engine (drives a vendor's official binary). */
export function isSubscriptionEngine(engine: RunEngine): engine is SubscriptionRunEngine {
  return engine !== "pi";
}

/**
 * True iff `engine` materialises the structured deliverable natively (see
 * {@link SubscriptionEngineBinding.nativeOutput}). The launcher uses this to
 * decide whether to serve the MCP `output` runtime tool to a run — native-output
 * engines must not be offered it. `"pi"` is always false. Reads the contributed
 * registry: an engine counts as native-output iff at least one registered
 * provider on that engine declared it.
 */
export function engineHasNativeOutput(engine: RunEngine): boolean {
  if (engine === "pi") return false;
  for (const def of BY_PROVIDER.values()) {
    if (def.engine === engine && def.nativeOutput) return true;
  }
  return false;
}
