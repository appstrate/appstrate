// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription run policy for the run launcher.
 *
 * The engine vocabulary + provider→engine binding live in core
 * (`@appstrate/core/subscription-engines`); this module is the launcher-side
 * policy that consumes them — it resolves credential-delivery mode from that
 * registry (`resolveCredentialDelivery`) and enforces the fail-closed guards a
 * subscription run must pass before launch. The engine itself is read off the
 * provider's `subscriptionEngine` binding (claude) with `pi` as the default.
 *
 * Which in-container agent engine a run executes on. Pi (the
 * `@mariozechner/pi-coding-agent` loop) runs every API-key provider; a
 * `claude-code` subscription run executes on the official **Claude Agent SDK**
 * instead — the official-binary path where the `claude` binary signs its own
 * client fingerprint (no forging). This is not a ToS certification: subscription
 * use is an operator opt-in grey-zone (see docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
 *
 * There is deliberately no fingerprint-forging fallback. An OAuth-subscription
 * provider runs on the engine that drives the vendor's OFFICIAL binary (which
 * signs its own fingerprint): `claude-code` → Claude Agent SDK. A subscription
 * with no such engine is rejected by {@link assertRunnableOnEngine} rather than
 * forged.
 */

import type { LlmProxyOauthConfig, ModelSwap } from "@appstrate/core/sidecar-types";
import { isSubscriptionEngine, type RunEngine } from "@appstrate/core/subscription-engines";
import {
  isOAuthModelProvider,
  subscriptionEngineForProvider,
} from "../model-providers/registry.ts";

export type { RunEngine };

/**
 * Single resolver for "what kind of credential is this and which engine runs it".
 *
 * Reads the provider→engine registry ONCE (plus the oauth-class flag for the
 * no-subscription-engine refuse path) so the launcher no longer maintains a
 * parallel `isOAuthModelProvider` axis alongside `subscriptionEngineForProvider`.
 * The oauth-class boolean and the resolved engine both flow from this one value.
 *
 * An oauth-class credential (one whose provider declares `authMode: "oauth2"`)
 * has its bearer swapped server-side by the sidecar `/llm` gateway — if it has
 * no subscription engine it is hard-refused downstream by {@link
 * assertRunnableOnEngine} (there is no forging fallback). Everything else is a
 * static API-key provider on the Pi engine.
 */
export function resolveCredentialDelivery(params: {
  providerId: string;
  /** Whether the resolved run actually carries a stored credential id. */
  hasCredentialId: boolean;
}): {
  /** True for any oauth-class credential — subscription OR engine-less. */
  isOauthCredential: boolean;
  engine: RunEngine;
} {
  const { providerId, hasCredentialId } = params;
  // One registry read: the resolved engine is the provider's subscription
  // engine (claude) or `pi` for every API-key / unregistered provider.
  const sub = subscriptionEngineForProvider(providerId);
  const engine = sub?.engine ?? "pi";

  // A credential is oauth-class when it has a stored credential id AND its
  // provider authenticates via OAuth — true both for a subscription engine and
  // for an oauth provider with no official engine (the refuse path).
  const isOauthCredential = hasCredentialId && isOAuthModelProvider(providerId);

  return { isOauthCredential, engine };
}

/**
 * Thrown when a run cannot execute because its credential is an OAuth
 * subscription with no official-binary engine (the only non-forging path).
 */
export class UnrunnableOauthProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" uses an OAuth subscription credential but has no ` +
        `official-binary execution engine. Subscription runs are only supported for ` +
        `providers whose engine drives the vendor's official binary (which signs ` +
        `its own client fingerprint); this credential's subscription engine has no ` +
        `such path. Connect an API-key model provider to run this agent.`,
    );
    this.name = "UnrunnableOauthProviderError";
  }
}

/**
 * Guard: an OAuth-subscription credential can only execute on an engine whose
 * driver signs its own client fingerprint — the `claude` (claude-code) engine.
 * Any other subscription resolves to the `pi` engine, which has no forging path
 * — so we refuse. Throws {@link UnrunnableOauthProviderError}.
 */
export function assertRunnableOnEngine(params: {
  engine: RunEngine;
  providerId: string;
  isOauthCredential: boolean;
}): void {
  const { engine, providerId, isOauthCredential } = params;
  if (isOauthCredential && !isSubscriptionEngine(engine)) {
    throw new UnrunnableOauthProviderError(providerId);
  }
}

/**
 * Thrown when a subscription AGENT run is launched without an isolation
 * boundary (RUN_ADAPTER=process). A subscription engine drives the vendor's
 * official binary against a personal login/subscription; that credential must
 * never execute in the host process, only inside the per-run isolation
 * boundary (Docker container or Firecracker microVM). Fail-closed: refuse
 * rather than leak the credential into the API process.
 */
export class SubscriptionRequiresIsolationError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" is an OAuth subscription and can only run inside ` +
        `an isolated agent boundary (RUN_ADAPTER=docker or RUN_ADAPTER=firecracker). ` +
        `The current execution mode is "process", which runs the agent in the host ` +
        `API process — unsafe for a subscription credential. Switch RUN_ADAPTER, or ` +
        `run this agent with an API-key model provider.`,
    );
    this.name = "SubscriptionRequiresIsolationError";
  }
}

/**
 * Fail-closed isolation guard for subscription AGENT runs. If the provider maps
 * to a subscription engine (claude-code → Claude Agent SDK) the run MUST execute
 * under an isolating orchestrator — docker (container boundary) or firecracker
 * (microVM boundary) — the modes that put the official binary + its credential
 * inside the per-run boundary. The process orchestrator runs in-host and would
 * expose the subscription token to the API process, so it is refused. API-key
 * providers (no subscription engine def) are unaffected. Claude *chat* never
 * reaches this path (host-side, token swapped gateway-side). Throws
 * {@link SubscriptionRequiresIsolationError}.
 *
 * Consumes the engine already resolved by {@link resolveCredentialDelivery} so
 * the launcher reads the provider→engine registry once rather than re-deriving
 * it here. `isSubscriptionEngine(engine)` is true for exactly the providers
 * `subscriptionEngineForProvider` would have matched (engine is `"pi"` for
 * everything else), so the guard's outcome is unchanged.
 */
export function assertSubscriptionEngineIsolation(params: {
  engine: RunEngine;
  providerId: string;
  orchestratorMode: "docker" | "process" | "firecracker";
}): void {
  const { engine, providerId, orchestratorMode } = params;
  if (isSubscriptionEngine(engine) && orchestratorMode === "process") {
    throw new SubscriptionRequiresIsolationError(providerId);
  }
}

/**
 * Build the sidecar `/llm` config for an OAuth-subscription run. The official
 * Claude Agent SDK binary signs its OWN fingerprint, so the sidecar only swaps
 * the bearer + ensures the OAuth beta — no identity headers, no system-prepend,
 * no body transform. Callers MUST have passed {@link assertRunnableOnEngine}
 * first (only the `claude` engine ever reaches here). Pure for unit testing.
 */
export function buildOauthSidecarLlm(params: {
  baseUrl: string;
  credentialId: string;
  modelSwap?: ModelSwap;
}): LlmProxyOauthConfig {
  const { baseUrl, credentialId, modelSwap } = params;
  return {
    authMode: "oauth",
    baseUrl,
    credentialId,
    ...(modelSwap ? { modelSwap } : {}),
  };
}
