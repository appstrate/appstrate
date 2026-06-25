// SPDX-License-Identifier: Apache-2.0

/**
 * Provider → execution-engine binding — the engine ROUTING CONTRACT.
 *
 * A model provider runs on one of three engines: the generic `pi` loop (every
 * API-key provider, and the default for anything unregistered), or a
 * subscription engine that drives a vendor's OFFICIAL binary so it signs its
 * own client fingerprint (no forging). What core owns here is the engine
 * VOCABULARY + the binding SHAPE — the `"claude"|"codex"` engines, the binding
 * fields (credential-delivery mode, egress allowlist, native-output capability,
 * chat handler) + the shared {@link ChatEngineInput} chat contract — and the
 * pure {@link isSubscriptionEngine} predicate. It ships ZERO bindings:
 * the `claude` (Claude Agent SDK) and `codex` (Codex CLI) bindings are
 * contributed at boot by their opt-in provider modules (`@appstrate/module-
 * claude-code`, `@appstrate/module-codex`) via the `subscriptionEngine` field on
 * their {@link ModelProviderDefinition}.
 *
 * There is NO registry here anymore. The provider definition is the SINGLE
 * source of truth for a provider's engine; the platform's model-provider
 * registry (apps/api) exposes pure read helpers (`engineForProvider`,
 * `subscriptionEngineForProvider`, `providerHasNativeOutput`) that read those
 * definitions directly, so the run, chat, and llm-proxy surfaces agree without
 * a second copied map. (This is engine-routing vocabulary, NOT billing
 * vocabulary — no billing concept lives here.)
 */

/** The execution engine for a resolved model. */
export type RunEngine = "pi" | "claude" | "codex";

/** A subscription engine — one that drives a vendor's official binary. */
export type SubscriptionRunEngine = Exclude<RunEngine, "pi">;

/**
 * One chat turn's inputs, handed to a subscription engine's {@link
 * SubscriptionEngineBinding.chatHandler}. Deliberately framework-neutral (no
 * `ai`/UI-stream types) so this can live in core as the SHARED contract between
 * the chat module (caller) and a provider module (implementer) — neither
 * imports the other; both depend only on core. The caller (module-chat)
 * pre-assembles the transcript into `prompt`, and the handler returns a web
 * `Response` (the UI-message-stream body). The vendor SDK + its UI-stream
 * mapping stay entirely inside the provider module.
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
  /**
   * Engine that drives this provider's official binary. This is also the sole
   * credential-delivery routing signal: the launcher derives the sidecar
   * delivery mode + egress lock from the engine (`codex` → vend with the codex
   * egress allowlist; every other subscription engine → oauth bearer-swap). See
   * `resolveCredentialDelivery` in the run launcher.
   */
  engine: SubscriptionRunEngine;
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
   * the chat driver too. The platform resolves this off the provider definition
   * and injects it into the chat module (which reads it through its
   * platform-deps, never importing this registry directly). Engines with no chat
   * surface (codex — agent-only) omit it, and the generic ai-sdk/pi chat path is
   * used for everything unregistered.
   */
  chatHandler?: (input: ChatEngineInput) => Response;
}

/** A binding plus the identity (provider id + label) it was registered under. */
export interface SubscriptionEngineDef extends SubscriptionEngineBinding {
  /** Credential provider id (e.g. `"claude-code"`, `"codex"`). */
  providerId: string;
  /** Human-readable provider name for user-facing messages. */
  label: string;
}

/** True iff `engine` is a subscription engine (drives a vendor's official binary). */
export function isSubscriptionEngine(engine: RunEngine): engine is SubscriptionRunEngine {
  return engine !== "pi";
}
