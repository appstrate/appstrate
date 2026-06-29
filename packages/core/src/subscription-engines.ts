// SPDX-License-Identifier: Apache-2.0

/**
 * Provider → execution-engine binding — the engine ROUTING CONTRACT.
 *
 * A model provider runs on one of two engines: the generic `pi` loop (every
 * API-key provider, and the default for anything unregistered), or a
 * subscription engine that drives the vendor's OFFICIAL binary so it signs its
 * own client fingerprint (no forging). Core owns only the engine VOCABULARY and
 * the binding SHAPE — the `"claude"` engine id, the binding field (`engine`),
 * and the pure {@link isSubscriptionEngine} predicate. This binding is
 * RUN-ONLY: it routes autonomous runs to an engine and carries NO interactive
 * chat surface. Core ships ZERO bindings: the `claude` (Claude Agent SDK)
 * binding is contributed at boot by its opt-in provider module
 * (`@appstrate/module-claude-code`) via the `subscriptionEngine` field on its
 * {@link ModelProviderDefinition}.
 *
 * No registry here. The provider definition is the SINGLE source of truth for a
 * provider's engine; the platform's model-provider registry (apps/api) exposes
 * a pure read helper (`subscriptionEngineForProvider`) that reads the
 * definitions directly, so the run, chat, and llm-proxy surfaces agree without
 * a second copied map. (This is engine-routing vocabulary, NOT billing
 * vocabulary — no billing concept lives here.)
 *
 * Interactive chat handlers are deliberately NOT part of this contract — they
 * flow through a separate platform-contract surface
 * (`./chat-engine-contract.ts`, registered/resolved via `ctx.services`), so a
 * future subscription engine never has to carry a chat-shaped API and the
 * run-engine binding never grows a chat surface.
 */

/** The execution engine resolved for a model. */
export type RunEngine = "pi" | "claude";

/** A subscription engine — one that drives the vendor's official binary. */
export type SubscriptionRunEngine = Exclude<RunEngine, "pi">;

/**
 * The engine binding a provider module contributes (on its
 * {@link ModelProviderDefinition.subscriptionEngine}). Carries no provider id /
 * label — those come from the provider definition itself at registration. This
 * binding is RUN-ONLY: it routes autonomous runs to an engine and intentionally
 * carries no interactive chat surface.
 */
export interface SubscriptionEngineBinding {
  /** The engine that drives the provider's official binary. */
  engine: SubscriptionRunEngine;
}

/** The binding plus the identity (provider id + label) it is registered under. */
export interface SubscriptionEngineDef extends SubscriptionEngineBinding {
  /** The credential provider id (e.g. `"claude-code"`). */
  providerId: string;
  /** Human-readable provider name for user-facing messages. */
  label: string;
}

/** True iff `engine` is a subscription engine (drives the vendor's official binary). */
export function isSubscriptionEngine(engine: RunEngine): engine is SubscriptionRunEngine {
  return engine !== "pi";
}
