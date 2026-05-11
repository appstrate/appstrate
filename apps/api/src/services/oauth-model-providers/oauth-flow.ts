// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token-import flow.
 *
 * Specialized for public PKCE clients (Codex, Claude Code) with no
 * `client_secret`. The official flow in @appstrate/connect requires a secret;
 * we read `clientId` from the runtime registry and skip the secret entirely.
 *
 * Persisted shape: a single row in `model_provider_credentials` with the
 * encrypted blob carrying `kind: "oauth"` (access + refresh tokens, scopes,
 * accountId, email, …). The same row is the lookup target for the sidecar's
 * `/internal/oauth-token/:id` polling and the BullMQ refresh worker scan.
 *
 * Why no `/initiate` + `/callback` here: the public CLI client_ids
 * (Codex `app_EMoamE…`, Claude Code `9d1c2…`) only allowlist
 * `http://localhost:PORT/...` redirect_uris baked into the official CLIs.
 * Any platform-hosted callback is rejected. The CLI (`appstrate connect`)
 * does the loopback dance locally via @mariozechner/pi-ai and POSTs the
 * resulting tokens to `/api/model-providers-oauth/import`, which calls
 * `importOAuthModelProviderConnection()` below.
 *
 * Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §4.
 */

import { createOAuthCredential } from "../model-provider-credentials.ts";
import { getModelProviderConfig } from "./registry.ts";
import { decodeCodexJwtPayload } from "./credentials.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

export interface ImportOAuthModelProviderInput {
  orgId: string;
  /** Kept for backward compat with the CLI body shape; unused by this service. */
  applicationId: string;
  userId: string;
  /** Kept for backward compat with the CLI body shape; unused by this service. */
  connectionProfileId?: string;
  /** Canonical providerId ("codex", "claude-code"). */
  providerId: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds since epoch. The CLI converts the provider's `expires_in`. */
  expiresAt?: number | null;
  /** Claude-only: surfaced from the token response body by the CLI. */
  subscriptionType?: string;
  /** Provider account email — Codex extracts from JWT, Claude from token body. */
  email?: string;
  /**
   * Codex only — pi-ai's `loginOpenAICodex` surfaces the JWT's
   * `chatgpt_account_id` claim as a top-level field. The CLI forwards it so
   * the platform persists the canonical value rather than re-deriving from
   * the JWT (defense in depth — server-side decode runs as fallback below).
   */
  accountId?: string;
}

export interface ImportOAuthModelProviderResult {
  /** UUID of the `model_provider_credentials` row. */
  providerKeyId: string;
  providerId: string;
  email?: string;
  subscriptionType?: string;
  availableModelIds: string[];
}

/**
 * Persist a token bundle the CLI obtained on the user's machine via a
 * loopback OAuth dance against the official provider client_id.
 *
 * Provider-specific extras:
 *   - Codex: `chatgpt_account_id` is decoded from the access JWT here, not
 *     trusted from the request body — even though the CLI runs on the user's
 *     machine, defense-in-depth keeps the platform from blindly persisting
 *     attacker-controlled fields.
 *   - Claude: `subscriptionType` and `email` come from the token response body
 *     and are passed through as opaque strings (the platform can't recover
 *     them server-side once the CLI has discarded the raw response).
 */
export async function importOAuthModelProviderConnection(
  input: ImportOAuthModelProviderInput,
): Promise<ImportOAuthModelProviderResult> {
  const config = getModelProviderConfig(input.providerId);
  if (!config || config.authMode !== "oauth2" || !config.oauth) {
    throw notFound(`Unknown OAuth model provider: ${input.providerId} (not in registry)`);
  }
  if (!input.label.trim()) {
    throw invalidRequest("`label` is required", "label");
  }
  if (!input.accessToken || !input.refreshToken) {
    throw invalidRequest("`accessToken` and `refreshToken` are required");
  }

  // Provider-specific claim extraction. The CLI forwards pi-ai's surfaced
  // `accountId` (preferred — same value pi-ai's runtime already validated
  // against the upstream contract); we fall back to a server-side JWT decode
  // if the CLI didn't include it. An attacker can't forge `accountId` past
  // the token itself because Codex's backend rejects mismatched
  // chatgpt-account-id headers.
  let accountId: string | undefined = input.accountId;
  let email: string | undefined = input.email;
  if (config.providerId === "codex") {
    const claims = decodeCodexJwtPayload(input.accessToken);
    if (!accountId) accountId = claims?.chatgpt_account_id;
    if (!email) email = claims?.email;
    // Hard fail on missing chatgpt-account-id at import time — the inference
    // probe and runtime calls both require this header. Persisting a
    // connection without it produces a credential that can't actually be used.
    if (!accountId) {
      throw invalidRequest(
        "Could not resolve chatgpt-account-id from the Codex token. " +
          "The CLI must forward `accountId` (pi-ai surfaces it as a top-level " +
          "field after a successful login) — rebuild the CLI: " +
          "`cd apps/cli && bun run build`.",
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
    providerKeyId: credentialId,
    providerId: input.providerId,
    email,
    subscriptionType: input.subscriptionType,
    availableModelIds: config.models.map((m) => m.id),
  };
}
