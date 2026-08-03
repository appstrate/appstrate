// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token-import flow.
 *
 * Specialized for public PKCE clients with no `client_secret`. The official
 * flow in @appstrate/connect requires a secret; we read `clientId` from the
 * runtime registry and skip the secret entirely.
 *
 * Persisted shape: a single row in `model_provider_credentials` with the
 * encrypted blob carrying `kind: "oauth"` (access + refresh tokens, scopes,
 * accountId, email, …). The same row is the lookup target for the sidecar's
 * `/internal/oauth-token/:id` polling and the BullMQ refresh worker scan.
 *
 * Why no `/initiate` + `/callback` here: the public CLI client_ids only
 * allowlist `http://localhost:PORT/...` redirect_uris baked into the
 * official CLIs. Any platform-hosted callback is rejected. The CLI
 * (`appstrate connect`) does the loopback dance locally via
 * @mariozechner/pi-ai and POSTs the resulting tokens to
 * `/api/model-providers-oauth/pair/redeem`, which calls
 * `importOAuthModelProviderConnection()` below.
 *
 * Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §4.
 */

import {
  createOAuthCredential,
  dedupeCredentialLabel,
  findMissingIdentityClaims,
  resolveCredentialModelIds,
  type CreateOAuthCredentialInput,
} from "./credentials.ts";
import { getModelProvider } from "./registry.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

export interface ImportOAuthModelProviderResult {
  /** UUID of the `model_provider_credentials` row. */
  credentialId: string;
  providerId: string;
  email?: string;
  availableModelIds: string[];
}

/**
 * Input for {@link importOAuthModelProviderConnection}. Mirrors
 * {@link CreateOAuthCredentialInput} but with an optional label — the
 * function derives one from the provider's `displayName` when the helper
 * doesn't supply it.
 */
export type ImportOAuthModelProviderInput = Omit<CreateOAuthCredentialInput, "label"> & {
  label?: string;
};

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
  if (!input.accessToken || !input.refreshToken) {
    throw invalidRequest("`accessToken` and `refreshToken` are required");
  }
  // Always dedupe, even when the caller (the connect-helper CLI) supplies a
  // label — its default (`ChatGPT`, `Claude`) is the same on every redeem, so
  // honouring it verbatim would name every connection identically. The base
  // is the supplied label, else the provider's displayName.
  const base = input.label?.trim() || config.displayName || config.providerId;
  const label = await dedupeCredentialLabel(input.orgId, base);

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
  const missing = findMissingIdentityClaims(config.requiredIdentityClaims, { accountId, email });
  if (missing.length > 0) {
    throw invalidRequest(
      `Could not resolve required identity slot(s) for ${config.providerId}: ${missing.join(", ")}. ` +
        `Re-run the OAuth flow or check the CLI version.`,
    );
  }
  logger.info("oauth model provider connection import", {
    providerId: config.providerId,
    hasAccountIdFromBody: !!input.accountId,
    hasAccountIdFinal: !!accountId,
    accountIdLength: accountId?.length ?? 0,
  });

  const credentialId = await createOAuthCredential({
    ...input,
    label,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  });

  // Report the credential's SERVABLE set, through the one accessor every read
  // path uses — not the narrower `featuredModels` subset this used to echo.
  // The helper prints this list in its terminal summary while the dashboard
  // renders `available_model_ids` off a GET of the very same credential;
  // sourcing them from two different resolutions made the two surfaces
  // disagree by construction on every connection (3 ids vs 7-8), even with
  // both lists perfectly current. Users read that as a bug, and it is one —
  // in the reporting. The invariant is: this value equals what a subsequent
  // GET returns.
  //
  // Still no discovery probe here, and the accessor's answer splits by
  // provider kind:
  //   - `modelDiscovery: { mode: "static" }` — derived from (definition ∩
  //     catalog), zero upstream calls. Already final at import time, and it
  //     tracks the catalog afterwards instead of freezing. Nothing is
  //     persisted for these (Phase 2), so the null column below is not a gap.
  //     Both OAuth providers registered today (claude-code, codex) are of
  //     this kind — the pairing flow exists for subscription sign-ins, which
  //     `docs/architecture/SUBSCRIPTION_COMPLIANCE.md` forbids probing at all.
  //   - probe providers — the persisted column, which is necessarily null on
  //     a row created microseconds ago: the model form (and the manual
  //     "Refresh models" button) probe the live credential and write it then.
  //     `[]` is the honest answer ("nothing discovered yet") and is exactly
  //     what the dashboard shows until discovery runs. No such provider can
  //     reach this function today, but the contract admits one; probing here
  //     would double the quota burst on connect for a list re-fetched anyway.
  return {
    credentialId,
    providerId: input.providerId,
    email,
    availableModelIds: resolveCredentialModelIds(input.providerId, null),
  };
}
