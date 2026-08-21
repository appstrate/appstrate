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
 * credential is delivered via the sidecar `/llm` bearer-swap (not a static
 * placeholder→key substitution), and the run MUST execute under an isolating
 * orchestrator because that swap only exists on the sidecar path.
 */

import type { LlmProxyOauthConfig } from "@appstrate/core/sidecar-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { orchestratorIsolatesWorkloads, isolatingOrchestratorIds } from "../orchestrator/index.ts";
import { isOAuthModelProvider } from "../model-providers/registry.ts";

/**
 * Thrown when a run resolves to an OAuth provider (`authMode: "oauth2"`) with
 * NO stored credential id. That configuration is invalid, never a downgrade:
 * an OAuth token can only be delivered via the sidecar bearer-swap keyed by a
 * `model_provider_credentials` row — treating the run as an API-key run would
 * put the RAW subscription token into `MODEL_API_KEY` inside the agent
 * container (and, with no integrations/proxy, skip the sidecar entirely).
 */
export class OauthProviderMissingCredentialError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider "${providerId}" declares authMode "oauth2" but the run resolved no stored ` +
        `credential id. OAuth subscription tokens are delivered via the sidecar bearer-swap ` +
        `against a stored model provider credential — they can never run as static API keys ` +
        `(the raw token would leak into the agent container). Bind the model to a stored ` +
        `OAuth credential; SYSTEM_PROVIDER_KEYS cannot carry OAuth providers.`,
    );
    this.name = "OauthProviderMissingCredentialError";
  }
}

/**
 * How a run's model credential reaches the upstream provider.
 *
 * A discriminated union, not a boolean flag: the `oauth` arm CARRIES the
 * credential id, so a caller that takes the oauth branch has the id in hand by
 * construction. The previous shape (`{ isOauthCredential: boolean }`) forced
 * every consumer to re-derive "oauth implies a credential id" — in practice
 * with a re-check plus a non-null assertion at the point of use, duplicating
 * the invariant this resolver already enforces.
 */
export type CredentialDelivery =
  /** Oauth-class credential — bearer swapped server-side by the sidecar `/llm` gateway. */
  | { readonly kind: "oauth"; readonly credentialId: string }
  /** Static API-key provider — the placeholder is substituted for the real key inline. */
  | { readonly kind: "api_key" };

/**
 * Single resolver for "what kind of credential is this and how is it delivered".
 *
 * Classification is by the provider's declared `authMode` FIRST: any provider
 * registered with `authMode: "oauth2"` is an oauth-class credential whose
 * bearer is swapped server-side by the sidecar `/llm` gateway — regardless of
 * whether a credential id happens to be present. An OAuth provider WITHOUT a
 * stored credential id is an invalid configuration and throws
 * {@link OauthProviderMissingCredentialError} (fail-closed — it must never be
 * downgraded to API-key handling, which would hand the raw token to the agent
 * container). Everything else is a static API-key provider whose placeholder
 * is substituted for the real key inline.
 */
export function resolveCredentialDelivery(params: {
  providerId: string;
  /** The stored credential id the run resolved, if any. */
  credentialId: string | null | undefined;
}): CredentialDelivery {
  const { providerId, credentialId } = params;
  if (!isOAuthModelProvider(providerId)) return { kind: "api_key" };
  if (!credentialId) throw new OauthProviderMissingCredentialError(providerId);
  return { kind: "oauth", credentialId };
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
