// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription run policy for the run launcher.
 *
 * The engine vocabulary + provider→engine binding live in core
 * (`@appstrate/core/subscription-engines`); this module is the launcher-side
 * policy that consumes them — it resolves credential-delivery mode from that
 * registry (`resolveCredentialDelivery`) and enforces the fail-closed guards a
 * subscription run must pass before launch. It does NOT select the engine;
 * `engineForProvider` does, in core.
 *
 * Which in-container agent engine a run executes on. Pi (the
 * `@mariozechner/pi-coding-agent` loop) runs every API-key provider; a
 * `claude-code` subscription run executes on the official **Claude Agent SDK**
 * instead — the official-binary path where the `claude` binary signs its own
 * client fingerprint (no forging). This is not a ToS certification: subscription
 * use is an operator opt-in grey-zone (see docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
 *
 * There is deliberately no fingerprint-forging fallback. Each OAuth-subscription
 * provider runs on the engine that drives the vendor's OFFICIAL binary (which
 * signs its own fingerprint): `claude-code` → Claude Agent SDK, `codex` → Codex
 * CLI. A subscription with no such engine is rejected by
 * {@link assertRunnableOnEngine} rather than forged.
 */

import type { LlmProxyOauthConfig, ModelSwap } from "@appstrate/core/sidecar-types";
import {
  isSubscriptionEngine,
  type RunEngine,
  type SubscriptionEngineDef,
} from "@appstrate/core/subscription-engines";
import {
  engineForProvider,
  isOAuthModelProvider,
  subscriptionEngineForProvider,
} from "../model-providers/registry.ts";

export type { RunEngine };

/**
 * Per-run egress allowlist for the Codex (vend) engine — the sole compensating
 * control for a run that holds the REAL ChatGPT subscription token in-container
 * (the CLI talks to chatgpt.com directly and can't be reverse-proxied). The
 * launcher carries it onto the sidecar `/llm` vend config, where the sidecar
 * forward-proxy ENFORCES it (suffix-matched). Suffix-matched, so it permits the
 * token to egress to ANY `*.openai.com` / `*.chatgpt.com` host — broader than
 * the few hosts the CLI needs, but an accepted threat-model decision (OpenAI
 * owns every such subdomain, the vended token is non-renewable, the container is
 * ephemeral, and the proxy pins allowlisted hosts to :443).
 */
export const CODEX_EGRESS_ALLOWLIST: readonly string[] = ["chatgpt.com", "openai.com"];

/**
 * The sidecar credential-delivery mode for a resolved run, derived from a SINGLE
 * source of truth.
 *
 * - `"oauth"` — the credential's bearer is swapped server-side by the sidecar
 *   `/llm` gateway (the official binary points at the gateway). Either an
 *   `"oauth"`-mode subscription engine (e.g. claude-code → Claude Agent SDK) OR
 *   an oauth-class credential with no subscription engine (which {@link
 *   assertRunnableOnEngine} then hard-refuses — there is no forging fallback).
 * - `"vend"` — a `"vend"`-mode subscription engine (e.g. codex → Codex CLI): the
 *   real token is vended into the container and egress is locked to the vendor's
 *   hosts (the sole compensating control).
 * - `"api_key"` — a static API-key provider (Pi engine).
 */
export type CredentialDeliveryMode = "oauth" | "vend" | "api_key";

/**
 * Single resolver for "what kind of credential is this and how is it delivered".
 *
 * Reads the provider→engine registry ONCE (plus the oauth-class flag for the
 * no-subscription-engine refuse path) so the launcher no longer maintains a
 * parallel `isOAuthModelProvider` axis alongside `subscriptionEngineForProvider`. The
 * delivery mode, the oauth-class boolean, the resolved engine, and the egress
 * allowlist all flow from this one value.
 *
 * Precedence: the `codex` subscription engine routes to `"vend"` (the only
 * engine that holds the real token in-container); any other subscription engine
 * (e.g. claude-code) and any oauth-class credential (a provider declaring
 * `authMode: "oauth2"` with NO subscription engine — hard-refused downstream by
 * {@link assertRunnableOnEngine}) is `"oauth"`; everything else is a static
 * `"api_key"` provider.
 */
export function resolveCredentialDelivery(params: {
  providerId: string;
  /** Whether the resolved run actually carries a stored credential id. */
  hasCredentialId: boolean;
}): {
  mode: CredentialDeliveryMode;
  /** True for any oauth-class credential — subscription OR engine-less. */
  isOauthCredential: boolean;
  engine: RunEngine;
  subscriptionEngine: SubscriptionEngineDef | undefined;
  egressAllowlist: readonly string[] | undefined;
} {
  const { providerId, hasCredentialId } = params;
  const subscriptionEngine = subscriptionEngineForProvider(providerId);
  const engine = engineForProvider(providerId);

  // A credential is oauth-class when it has a stored credential id AND its
  // provider authenticates via OAuth — true both for a subscription engine and
  // for an oauth provider with no official engine (the refuse path).
  const isOauthCredential = hasCredentialId && isOAuthModelProvider(providerId);

  if (subscriptionEngine?.engine === "codex") {
    return {
      mode: "vend",
      isOauthCredential,
      engine,
      subscriptionEngine,
      egressAllowlist: CODEX_EGRESS_ALLOWLIST,
    };
  }
  if (isOauthCredential) {
    return {
      mode: "oauth",
      isOauthCredential,
      engine,
      subscriptionEngine,
      egressAllowlist: undefined,
    };
  }
  return {
    mode: "api_key",
    isOauthCredential,
    engine,
    subscriptionEngine,
    egressAllowlist: undefined,
  };
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
 * driver signs its own client fingerprint — the `claude` (claude-code) or
 * `codex` engine. Any other subscription resolves to the `pi` engine, which has
 * no forging path — so we refuse. Throws {@link UnrunnableOauthProviderError}.
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
 * Thrown when a subscription AGENT run is launched outside a Docker container.
 * A subscription engine drives the vendor's official binary against a personal
 * login/subscription; that credential must never execute in the host process,
 * only inside the per-run isolation boundary. Fail-closed: refuse rather than
 * leak the credential into the API process.
 */
export class SubscriptionRequiresDockerError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" is an OAuth subscription and can only run as a ` +
        `Docker-isolated agent (RUN_ADAPTER=docker). The current execution mode is ` +
        `"process", which runs the agent in the host API process — unsafe for a ` +
        `subscription credential. Switch RUN_ADAPTER to docker, or run this agent ` +
        `with an API-key model provider.`,
    );
    this.name = "SubscriptionRequiresDockerError";
  }
}

/**
 * Fail-closed isolation guard for subscription AGENT runs. If the provider maps
 * to a subscription engine (claude-code → Claude Agent SDK, codex → Codex CLI)
 * the run MUST execute under the docker orchestrator — the only mode that puts
 * the official binary + its credential inside the per-run boundary. The process
 * orchestrator runs in-host and would expose the subscription token to the API
 * process, so it is refused. API-key providers (no subscription engine def) are
 * unaffected. Claude *chat* never reaches this path (host-side, token swapped
 * gateway-side). Throws {@link SubscriptionRequiresDockerError}.
 */
export function assertSubscriptionEngineIsolation(params: {
  providerId: string;
  orchestratorMode: "docker" | "process";
}): void {
  const { providerId, orchestratorMode } = params;
  if (subscriptionEngineForProvider(providerId) && orchestratorMode !== "docker") {
    throw new SubscriptionRequiresDockerError(providerId);
  }
}

/** Thrown when a `vend`-mode (subscription) run declares integrations. */
export class VendRunIntegrationsError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" is a subscription (vend) credential: the real token is ` +
        `served to the in-container runner over the per-run network, which integration ` +
        `runner containers also join. A vend run therefore cannot declare integrations ` +
        `until per-integration network isolation exists. Use an API-key model provider ` +
        `for integration-backed runs.`,
    );
    this.name = "VendRunIntegrationsError";
  }
}

/**
 * Fail-closed guard keeping all three runners (pi / claude / codex) on ONE trust
 * model: the per-run Docker network IS the boundary and every sidecar-internal
 * endpoint (`/mcp`, `/integrations/boot-report`, `/credential-vend`) is gated by
 * network membership alone — no per-endpoint auth. That is sound only when the
 * network carries no untrusted peers. The vend path is the single runner that
 * hands the REAL subscription token into the container, so a sibling integration
 * container on the same network could otherwise vend it from `/credential-vend`.
 * Rather than diverge codex with a bespoke endpoint secret, we keep the trust
 * model uniform and enforce its precondition here: a vend run must not place
 * untrusted integration containers on the network. Throws
 * {@link VendRunIntegrationsError}. (No-op for `oauth`/`api_key`/`pi` runs, which
 * never put a real token in the container.)
 */
export function assertVendRunHasNoIntegrations(params: {
  mode: CredentialDeliveryMode;
  providerId: string;
  integrationCount: number;
}): void {
  if (params.mode === "vend" && params.integrationCount > 0) {
    throw new VendRunIntegrationsError(params.providerId);
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
