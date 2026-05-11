// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token-import flow.
 *
 * Specialized for public PKCE clients (Codex and similar OAuth providers) with no
 * `client_secret`. The official flow in @appstrate/connect requires a secret;
 * we read `clientId` from the runtime registry and skip the secret entirely.
 *
 * Persisted shape: a single row in `model_provider_credentials` with the
 * encrypted blob carrying `kind: "oauth"` (access + refresh tokens, scopes,
 * accountId, email, …). The same row is the lookup target for the sidecar's
 * `/internal/oauth-token/:id` polling and the BullMQ refresh worker scan.
 *
 * Why no `/initiate` + `/callback` here: the public CLI client_ids
 * (Codex `app_EMoamE…`) only allowlist
 * `http://localhost:PORT/...` redirect_uris baked into the official CLIs.
 * Any platform-hosted callback is rejected. The CLI (`appstrate connect`)
 * does the loopback dance locally via @mariozechner/pi-ai and POSTs the
 * resulting tokens to `/api/model-providers-oauth/import`, which calls
 * `importOAuthModelProviderConnection()` below.
 *
 * Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §4.
 */

import { createOAuthCredential } from "../model-provider-credentials.ts";
import { getModelProvider } from "../model-providers/registry.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

export interface ImportOAuthModelProviderInput {
  orgId: string;
  userId: string;
  /** Canonical providerId — must be registered + `authMode: "oauth2"`. */
  providerId: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds since epoch. The CLI converts the provider's `expires_in`. */
  expiresAt?: number | null;
  /** Free-form subscription tier from the OAuth response body, passed through as opaque metadata. */
  subscriptionType?: string;
  /** Account email — body takes precedence over the value the hook re-derives. */
  email?: string;
  /**
   * Abstract account/tenant identifier — the well-known `accountId` slot
   * from {@link ModelProviderIdentity}. Forwarded by the CLI when the
   * upstream OAuth response surfaces it as a top-level field; the
   * provider's `extractTokenIdentity` hook fills it in server-side as a
   * defense-in-depth fallback.
   */
  accountId?: string;
}

export interface ImportOAuthModelProviderResult {
  /** UUID of the `model_provider_credentials` row. */
  credentialId: string;
  providerId: string;
  email?: string;
  subscriptionType?: string;
  availableModelIds: string[];
}

/**
 * Persist a token bundle the CLI obtained on the user's machine via a
 * loopback OAuth dance against the official provider client_id.
 *
 * Identity slots (`accountId`, `email`) are resolved provider-agnostically:
 * the body-level value takes precedence, the registered provider's
 * `extractTokenIdentity` hook fills in the gaps. `requiredIdentityClaims`
 * on the provider definition acts as a declarative gate so the platform
 * refuses to persist a credential whose mandatory slots can't be resolved.
 */
export async function importOAuthModelProviderConnection(
  input: ImportOAuthModelProviderInput,
): Promise<ImportOAuthModelProviderResult> {
  const config = getModelProvider(input.providerId);
  if (!config || config.authMode !== "oauth2" || !config.oauth) {
    throw notFound(`Unknown OAuth model provider: ${input.providerId} (not in registry)`);
  }
  if (!input.label.trim()) {
    throw invalidRequest("`label` is required", "label");
  }
  if (!input.accessToken || !input.refreshToken) {
    throw invalidRequest("`accessToken` and `refreshToken` are required");
  }

  // Identity extraction is delegated to the provider's module via the
  // `extractTokenIdentity` hook, which maps provider-specific claims into
  // the platform's abstract identity slots (`accountId`, `email`). The CLI
  // may also forward identity slots directly after its loopback dance; the
  // body-level value takes precedence, the hook fills in the gaps. An
  // attacker can't forge identity past the token itself — upstream backends
  // reject mismatched routing headers.
  const claims = config.hooks?.extractTokenIdentity?.(input.accessToken) ?? null;
  const accountId: string | undefined = input.accountId ?? claims?.accountId;
  const email: string | undefined = input.email ?? claims?.email;

  // Provider-declared required identity slots — declarative gate so the
  // platform refuses to persist a credential that downstream calls can't
  // actually use (e.g. when an `accountId` is mandatory for the upstream
  // backend's routing header).
  const required = config.requiredIdentityClaims ?? [];
  if (required.length > 0) {
    const identity = { accountId, email };
    const missing = required.filter((k) => !identity[k]);
    if (missing.length > 0) {
      throw invalidRequest(
        `Could not resolve required identity slot(s) for ${config.providerId}: ${missing.join(", ")}. ` +
          `Re-run the OAuth flow or check the CLI version.`,
      );
    }
  }
  logger.info("oauth model provider connection import", {
    providerId: config.providerId,
    hasAccountIdFromBody: !!input.accountId,
    hasAccountIdFinal: !!accountId,
    accountIdLength: accountId?.length ?? 0,
  });

  const credentialId = await createOAuthCredential({
    orgId: input.orgId,
    userId: input.userId,
    label: input.label,
    providerId: config.providerId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt ?? null,
    scopesGranted: [...config.oauth.scopes],
    ...(accountId ? { accountId } : {}),
    ...(input.subscriptionType ? { subscriptionType: input.subscriptionType } : {}),
    ...(email ? { email } : {}),
  });

  return {
    credentialId: credentialId,
    providerId: input.providerId,
    email,
    subscriptionType: input.subscriptionType,
    availableModelIds: config.models.map((m) => m.id),
  };
}
