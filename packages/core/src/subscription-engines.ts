// SPDX-License-Identifier: Apache-2.0

/**
 * Provider → execution-engine binding — a CONTRIBUTED registry.
 *
 * A model provider runs on one of three engines: the generic `pi` loop (every
 * API-key provider, and the default for anything unregistered), or a
 * subscription engine that drives a vendor's OFFICIAL binary so it signs its
 * own client fingerprint (no forging). What core owns here is the engine
 * REGISTRY CONTRACT — the `"claude"|"codex"` engine vocabulary, the binding
 * shape (credential-delivery mode, egress allowlist, native-output capability,
 * chat handler), and the read/write accessors. It ships ZERO bindings populated:
 * the `claude` (Claude Agent SDK) and `codex` (Codex CLI) bindings are
 * contributed at boot by their opt-in provider modules (`@appstrate/module-
 * claude-code`, `@appstrate/module-codex`) via the `subscriptionEngine` field
 * on their {@link ModelProviderDefinition}. With those modules absent (the OSS
 * default), the registry stays empty and every provider resolves to `"pi"`, so
 * core carries no vendor binding — only the routing contract that lets the run,
 * chat, and llm-proxy surfaces agree on which engine a provider runs on. (This
 * is engine-routing vocabulary, NOT billing vocabulary — no billing concept
 * lives here.)
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
 * One chat turn's inputs, handed to a subscription engine's {@link
 * SubscriptionEngineBinding.chatHandler}. Deliberately framework-neutral (no
 * `ai`/UI-stream types) so this contract can live in core: the caller
 * (module-chat) pre-assembles the transcript into `prompt`, and the handler
 * returns a web `Response` (the UI-message-stream body). The vendor SDK + its
 * UI-stream mapping stay entirely inside the provider module.
 */
export interface ChatEngineInput {
  /** Pre-assembled transcript prompt for this turn (caller builds it). */
  prompt: string;
  /** System persona (+ MCP instructions + host context), already assembled. */
  system: string;
  /** Real upstream model id (e.g. `claude-haiku-4-5`) — NOT the preset id. */
  modelId: string;
  /** Credential-injection gateway base URL (`…/<providerId>-sdk/:presetId`). */
  gatewayBaseUrl: string;
  /** Placeholder bearer the binary sends; the gateway swaps it server-side. */
  placeholderToken: string;
  /** Platform HTTP MCP server (meta-tools); omitted when the mcp module is off. */
  platformMcp?: { url: string; headers: Record<string, string> };
  /** Aborts the engine when the client disconnects. */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
}

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
   * This invariant is enforced downstream at launch/boot — by the run launcher
   * (`pi.ts`) and the sidecar (`server.ts`) — not by this registry.
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
  /**
   * Chat-turn handler for an engine that has a chat surface. Contributed by the
   * provider module — which owns the vendor SDK — so dropping the module removes
   * the chat driver too. module-chat dispatches to this by provider id, exactly
   * as the run launcher and the llm-proxy gateway read this same registry, so
   * the three surfaces can't disagree. Engines with no chat surface (codex —
   * agent-only) omit it, and the generic `ai-sdk`/`pi` chat path is used for
   * everything unregistered.
   */
  chatHandler?: (input: ChatEngineInput) => Response;
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
 * Contribute a subscription-engine binding for a provider. The registry guards
 * against a CONFLICTING-engine re-registration (same provider id, different
 * engine) — that would mean two modules disagree on a provider's engine, exactly
 * the drift this single registry exists to prevent. A same-engine re-register is
 * allowed (so boot can run more than once in a single process); note it
 * overwrites the prior binding rather than asserting field-by-field equality.
 *
 * The registry does NOT enforce the `vend ⟺ egressAllowlist` invariant — that is
 * enforced downstream at launch/boot by the run launcher (`pi.ts`) and the
 * sidecar (`server.ts`).
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
 * True iff PROVIDER materialises the structured deliverable natively (see
 * {@link SubscriptionEngineBinding.nativeOutput}). The launcher uses this to
 * decide whether to serve the MCP `output` runtime tool to a run — a
 * native-output provider must not be offered it. Provider-specific, NOT
 * engine-wide: a second provider on the same engine that does NOT emit output
 * natively must not inherit the capability (it would lose its MCP `output`
 * path). An unregistered / API-key provider (resolves to `"pi"`) is always
 * false.
 */
export function providerHasNativeOutput(providerId: string): boolean {
  return BY_PROVIDER.get(providerId)?.nativeOutput === true;
}
