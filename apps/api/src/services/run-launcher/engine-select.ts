// SPDX-License-Identifier: Apache-2.0

/**
 * Runner engine selection.
 *
 * Which in-container agent engine a run executes on. Pi (the
 * `@mariozechner/pi-coding-agent` loop) runs every API-key provider; a
 * `claude-code` subscription run executes on the official **Claude Agent SDK**
 * instead — the ToS-clean path where the official `claude` binary signs its own
 * client fingerprint.
 *
 * There is deliberately no fingerprint-forging fallback. Each OAuth-subscription
 * provider runs on the engine that drives the vendor's OFFICIAL binary (which
 * signs its own fingerprint): `claude-code` → Claude Agent SDK, `codex` → Codex
 * CLI. A subscription with no such engine is rejected by
 * {@link assertRunnableOnEngine} rather than forged.
 */

import type { LlmProxyOauthConfig, ModelSwap } from "@appstrate/core/sidecar-types";
import {
  engineForProvider,
  isSubscriptionEngine,
  subscriptionEngineDef,
  type RunEngine,
} from "@appstrate/core/subscription-engines";

export { subscriptionEngineDef };
export type { RunEngine };

/**
 * Pick the engine for a resolved model — delegates to the shared registry
 * ({@link engineForProvider}) so chat + runs agree. `claude-code` → `"claude"`,
 * `codex` → `"codex"`, everything else → `"pi"`. Pure for unit testing.
 */
export function selectRunEngine(resolved: { providerId: string }): RunEngine {
  return engineForProvider(resolved.providerId);
}

/**
 * Thrown when a run cannot execute because its credential is an OAuth
 * subscription with no ToS-compliant engine.
 */
export class UnrunnableOauthProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" uses an OAuth subscription credential but has no ` +
        `ToS-compliant execution engine. Subscription runs are supported for ` +
        `"claude-code" (Claude Agent SDK) and "codex" (Codex CLI) — both drive the ` +
        `vendor's official binary, which signs its own client fingerprint. Connect ` +
        `an API-key model provider to run this agent.`,
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
