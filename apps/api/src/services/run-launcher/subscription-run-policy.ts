// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth-subscription run policy for the run launcher.
 *
 * Every run — API-key AND OAuth subscription (Claude Pro/Max, ChatGPT Codex) —
 * executes on the SINGLE Pi engine (`@mariozechner/pi-coding-agent`). Pi's SDK
 * (`@mariozechner/pi-ai`) natively speaks the subscription request shapes: for
 * an Anthropic OAuth token it emits the Claude Code fingerprint (bearer,
 * `anthropic-beta: oauth-2025-04-20`, the `claude-cli` user-agent, the
 * "You are Claude Code" system prelude); for a ChatGPT Codex token it emits the
 * codex-responses shape (bearer + `chatgpt-account-id`). The request-shape
 * fingerprint is therefore Pi's, not the platform's — the platform forges
 * nothing and delegates subscription request formatting to Pi. Subscription use
 * remains an operator opt-in grey-zone (see
 * docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
 *
 * This module owns the two things that still differ for an OAuth run: the
 * credential is delivered via the sidecar `/llm` bearer-swap (not a static
 * placeholder→key substitution), and the run MUST execute under an isolating
 * orchestrator because that swap only exists on the sidecar path.
 */

import type { LlmProxyOauthConfig, ModelSwap } from "@appstrate/core/sidecar-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { orchestratorIsolatesWorkloads, isolatingOrchestratorIds } from "../orchestrator/index.ts";
import { isOAuthModelProvider } from "../model-providers/registry.ts";

/**
 * Single resolver for "what kind of credential is this and how is it delivered".
 *
 * An oauth-class credential (one whose provider declares `authMode: "oauth2"`
 * AND that resolved to a stored credential id) has its bearer swapped
 * server-side by the sidecar `/llm` gateway. Everything else is a static
 * API-key provider whose placeholder is substituted for the real key inline.
 */
export function resolveCredentialDelivery(params: {
  providerId: string;
  /** Whether the resolved run actually carries a stored credential id. */
  hasCredentialId: boolean;
}): {
  /** True for an oauth-class credential — delivered via the sidecar bearer-swap. */
  isOauthCredential: boolean;
} {
  const { providerId, hasCredentialId } = params;
  const isOauthCredential = hasCredentialId && isOAuthModelProvider(providerId);
  return { isOauthCredential };
}

/**
 * Thrown when an OAuth-subscription run is launched without an isolation
 * boundary (e.g. RUN_ADAPTER=process). An OAuth run delivers its credential via
 * the sidecar `/llm` bearer-swap: the real subscription token is fetched by the
 * sidecar and never enters the agent container. That swap only exists on the
 * sidecar path, which only an isolating orchestrator (Docker container /
 * Firecracker microVM) provisions. Under the in-host process orchestrator there
 * is no sidecar to swap the bearer, so the run cannot deliver its credential.
 * Fail-closed: refuse rather than run unauthenticated.
 */
export class OauthRunRequiresIsolationError extends Error {
  constructor(
    public readonly providerId: string,
    orchestratorMode: string,
  ) {
    const isolating = isolatingOrchestratorIds()
      .map((id) => `RUN_ADAPTER=${id}`)
      .join(" or ");
    super(
      `Provider "${providerId}" uses an OAuth subscription credential, which is ` +
        `delivered through the sidecar (${isolating}). The current execution mode ` +
        `"${orchestratorMode}" does not provision a sidecar to swap the bearer — ` +
        `the run could not authenticate. Switch RUN_ADAPTER, or run this agent ` +
        `with an API-key model provider.`,
    );
    this.name = "OauthRunRequiresIsolationError";
  }
}

/**
 * Fail-closed isolation guard for OAuth-subscription runs. An OAuth credential's
 * bearer is swapped in by the sidecar, so the run MUST execute under an
 * orchestrator whose registration declares `isolatesWorkloads` — docker
 * (container boundary) or firecracker (microVM boundary). The check is an
 * allowlist against the orchestrator registry, not a denylist of known-bad
 * modes: a backend that never declared isolation (including any future one) is
 * refused by default. API-key providers are unaffected. Throws
 * {@link OauthRunRequiresIsolationError}.
 */
export function assertOauthRunIsolation(params: {
  isOauthCredential: boolean;
  providerId: string;
  orchestratorMode: ExecutionMode;
}): void {
  const { isOauthCredential, providerId, orchestratorMode } = params;
  if (isOauthCredential && !orchestratorIsolatesWorkloads(orchestratorMode)) {
    throw new OauthRunRequiresIsolationError(providerId, orchestratorMode);
  }
}

/**
 * Build the sidecar `/llm` config for an OAuth-subscription run. The Pi SDK
 * signs the subscription request shape itself, so the sidecar only swaps the
 * placeholder bearer for the real token — no identity headers, no
 * system-prepend, no body transform. Pure for unit testing.
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
