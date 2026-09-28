// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth-subscription run policy for the run launcher.
 *
 * Every run — API-key AND OAuth subscription (Claude Pro/Max, ChatGPT Codex) —
 * executes on the SINGLE Pi engine (`@earendil-works/pi-coding-agent`). Pi's SDK
 * (`@earendil-works/pi-ai`) natively speaks the subscription request shapes: for
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
 * credential is delivered via the sidecar `/llm` bearer-swap (an API-key run is
 * served by the platform LLM proxy instead), and the run MUST execute under an
 * isolating orchestrator, the only kind that keeps the sidecar's credential
 * apart from the agent.
 */

import type { LlmProxyOauthConfig } from "@appstrate/core/sidecar-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { orchestratorIsolatesWorkloads, isolatingOrchestratorIds } from "../orchestrator/index.ts";
import { isOAuthModelProvider } from "../model-providers/registry.ts";
import type { InferenceRoute } from "@appstrate/db/schema";

/**
 * Thrown when a run resolves to an OAuth provider (`authMode: "oauth2"`) with
 * NO stored credential id. That configuration is invalid, never a downgrade:
 * an OAuth token can only be delivered via the sidecar bearer-swap keyed by a
 * `model_provider_credentials` row — treating the run as an API-key run would
 * hand the sidecar a subscription token it can neither refresh nor route.
 */
export class OauthProviderMissingCredentialError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" declares authMode "oauth2" but the run resolved no stored ` +
        `credential id. OAuth subscription tokens are delivered via the sidecar bearer-swap ` +
        `against a stored model provider credential — they can never run as static API keys ` +
        `(the sidecar could neither refresh nor route it). Bind the model to a stored ` +
        `OAuth credential; SYSTEM_PROVIDER_KEYS cannot carry OAuth providers.`,
    );
    this.name = "OauthProviderMissingCredentialError";
  }
}

/**
 * `runs.inference_route`: an OAuth subscription keeps its own request shape
 * through the sidecar bearer-swap.
 */
export function inferenceRouteOf(model: { providerId: string }): InferenceRoute {
  return isOAuthModelProvider(model.providerId) ? "sidecar" : "proxy";
}

/**
 * The run's {@link inferenceRouteOf}, with the stored credential a sidecar run
 * swaps in. An OAuth provider without one throws rather than falling to the
 * proxy, which cannot use a subscription token.
 */
export function resolveCredentialDelivery(model: {
  providerId: string;
  credentialId?: string | null;
}): { readonly route: "proxy" } | { readonly route: "sidecar"; readonly credentialId: string } {
  const route = inferenceRouteOf(model);
  if (route === "proxy") return { route };
  if (!model.credentialId) throw new OauthProviderMissingCredentialError(model.providerId);
  return { route, credentialId: model.credentialId };
}

/**
 * Thrown when an OAuth-subscription run is launched without an isolation
 * boundary (e.g. RUN_ADAPTER=process). An OAuth run delivers its credential via
 * the sidecar `/llm` bearer-swap: the sidecar holds what it needs to fetch the
 * real subscription token, and the agent only ever sees a placeholder. That
 * separation holds only under an isolating orchestrator (Docker container /
 * Firecracker microVM). The process orchestrator runs the agent and its sidecar
 * as host processes of one user, so nothing keeps the agent from the sidecar's
 * environment. Fail-closed: refuse rather than run without that boundary.
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
        `kept apart from the agent by an isolating orchestrator (${isolating}). The ` +
        `current execution mode "${orchestratorMode}" runs the agent and its sidecar ` +
        `as host processes of one user. Switch RUN_ADAPTER, or run this agent ` +
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
 * Thrown when an OAuth-subscription run resolves to an ALIASED model. The
 * sidecar's oauth `/llm` mode is a pure bearer-swap — it never rewrites the
 * request/response body, so the alias could neither reach the upstream under
 * its real id nor stay masked on the way back. Alias creation already rejects
 * oauth-backed credentials (`checkAliasInvariants` → `oauth_provider`); this
 * launch-time guard fail-closes any row that predates that rule.
 */
export class OauthAliasedModelUnsupportedError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" uses an OAuth subscription credential, whose run path ` +
        `is a pure bearer-swap and never rewrites the request body — a model alias ` +
        `cannot be swapped there. Bind the alias to an API-key credential, or run ` +
        `this agent on the un-aliased subscription model.`,
    );
    this.name = "OauthAliasedModelUnsupportedError";
  }
}

/**
 * Fail-closed alias guard for OAuth-subscription runs. Throws
 * {@link OauthAliasedModelUnsupportedError} when the resolved model is an
 * alias backed by an oauth credential. API-key aliases are unaffected.
 */
export function assertOauthRunNotAliased(params: {
  isOauthCredential: boolean;
  aliased: boolean;
  providerId: string;
}): void {
  const { isOauthCredential, aliased, providerId } = params;
  if (isOauthCredential && aliased) {
    throw new OauthAliasedModelUnsupportedError(providerId);
  }
}

/**
 * Build the sidecar `/llm` config for an OAuth-subscription run. The Pi SDK
 * signs the subscription request shape itself, so the sidecar only swaps the
 * placeholder bearer for the real token — no identity headers, no
 * system-prepend, no body transform (aliases are rejected upstream by
 * {@link assertOauthRunNotAliased}). Pure for unit testing.
 */
export function buildOauthSidecarLlm(params: {
  baseUrl: string;
  credentialId: string;
}): LlmProxyOauthConfig {
  const { baseUrl, credentialId } = params;
  return {
    authMode: "oauth",
    baseUrl,
    credentialId,
  };
}
