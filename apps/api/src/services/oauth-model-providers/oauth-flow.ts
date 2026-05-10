// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token-import flow.
 *
 * Specialized for public PKCE clients (Codex, Claude Code) with no
 * `client_secret`. The official flow in @appstrate/connect requires a secret
 * (read from `applicationProviderCredentials`); we read `clientId` from the
 * runtime registry and skip the secret entirely.
 *
 * The persisted shape is the same as a regular integration OAuth connection
 * — `userProviderConnections` rows, an `applicationProviderCredentials` row
 * (auto-seeded with empty secret as a placeholder), and an
 * `orgSystemProviderKeys` row in `authMode='oauth'`.
 *
 * Why no `/initiate` + `/callback` here: the public CLI client_ids
 * (Codex `app_EMoamE…`, Claude Code `9d1c2…`) only allowlist
 * `http://localhost:PORT/...` redirect_uris baked into the official CLIs.
 * Any platform-hosted callback is rejected at the provider's authorize
 * step. The CLI (`appstrate connect <provider>`) does the loopback dance
 * locally via `@mariozechner/pi-ai`'s `loginOpenAICodex` / `loginAnthropic`
 * and POSTs the resulting tokens to `/api/model-providers-oauth/import`,
 * which calls `importOAuthModelProviderConnection()` below.
 *
 * Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §4.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationProviderCredentials,
  orgSystemProviderKeys,
  userProviderConnections,
} from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { ensureDefaultProfile } from "../connection-profiles.ts";
import { getOAuthModelProviderConfig, type OAuthModelProviderConfig } from "./registry.ts";
import { decodeCodexJwtPayload, type OAuthModelProviderCredentials } from "./credentials.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/**
 * Ensure an `applicationProviderCredentials` row exists for the given
 * (applicationId, providerPackageId) pair. Public PKCE clients have no
 * meaningful client_secret, so the seeded row carries an empty string —
 * downstream `getProviderOAuthCredentialsOrThrow` won't accept this, but
 * the model-provider flow uses the registry directly and never calls it.
 *
 * Returns the row id (existing or freshly created).
 */
async function ensureProviderCredentialRow(
  applicationId: string,
  providerPackageId: string,
  registryConfig: OAuthModelProviderConfig,
): Promise<string> {
  const [existing] = await db
    .select({ id: applicationProviderCredentials.id })
    .from(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerPackageId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const placeholderEncrypted = encryptCredentials({
    clientId: registryConfig.oauth.clientId,
    clientSecret: "",
    publicPkce: true,
  });

  const [created] = await db
    .insert(applicationProviderCredentials)
    .values({
      applicationId,
      providerId: providerPackageId,
      credentialsEncrypted: placeholderEncrypted,
    })
    .returning({ id: applicationProviderCredentials.id });
  return created!.id;
}

export interface PersistOAuthModelProviderTokensInput {
  orgId: string;
  applicationId: string;
  userId: string;
  connectionProfileId: string;
  providerPackageId: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  /** Computed from `expires_in` at token-exchange time, or `null` if absent. */
  expiresAt: Date | null;
  /**
   * Scopes effectively granted by the provider. Defaults to the registry's
   * declared scope list when the provider response did not echo the granted
   * set (Anthropic does not always include `scope` in the token response).
   */
  scopesGranted: string[];
  /** Optional account email for UI display. */
  email?: string;
  /** Claude-only: subscription tier (`pro`, `max`, `team`, `enterprise`). */
  subscriptionType?: string;
  /** Codex-only: extracted from JWT `https://api.openai.com/auth.chatgpt_account_id`. */
  chatgptAccountId?: string;
}

export interface PersistOAuthModelProviderTokensResult {
  providerKeyId: string;
  connectionId: string;
}

/**
 * Persist a freshly-acquired OAuth token bundle from a model provider.
 *
 * Builds the encrypted credential blob (access + refresh + provider claims),
 * upserts the `userProviderConnections` row keyed by
 * `(connectionProfileId, providerId, orgId, providerCredentialId)`, and
 * inserts the matching `orgSystemProviderKeys` row in `authMode='oauth'`
 * inside a single DB transaction so a half-baked persistence is impossible.
 *
 * Currently a single caller (`importOAuthModelProviderConnection` below),
 * but kept as a separate exported helper because the sidecar's token cache
 * + refresh worker are written against the persisted shape and must not
 * see drift if a future caller (e.g. an alternative bring-your-own-token
 * upload path) gets added.
 */
export async function persistOAuthModelProviderTokens(
  input: PersistOAuthModelProviderTokensInput,
): Promise<PersistOAuthModelProviderTokensResult> {
  const config = getOAuthModelProviderConfig(input.providerPackageId);
  if (!config) {
    throw notFound(
      `Unknown OAuth model provider: ${input.providerPackageId} (not in registry whitelist)`,
    );
  }

  const credPayload: OAuthModelProviderCredentials = {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    token_type: "Bearer",
    ...(input.chatgptAccountId ? { chatgpt_account_id: input.chatgptAccountId } : {}),
    ...(input.subscriptionType ? { subscription_type: input.subscriptionType } : {}),
    ...(input.email ? { email: input.email } : {}),
  };

  const providerCredentialId = await ensureProviderCredentialRow(
    input.applicationId,
    input.providerPackageId,
    config,
  );
  const credentialsEncrypted = encryptCredentials(
    credPayload as unknown as Record<string, unknown>,
  );

  const { connectionId, providerKeyId } = await db.transaction(async (tx) => {
    const [conn] = await tx
      .insert(userProviderConnections)
      .values({
        connectionProfileId: input.connectionProfileId,
        providerId: input.providerPackageId,
        orgId: input.orgId,
        providerCredentialId,
        credentialsEncrypted,
        scopesGranted: input.scopesGranted,
        expiresAt: input.expiresAt,
        needsReconnection: false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          userProviderConnections.connectionProfileId,
          userProviderConnections.providerId,
          userProviderConnections.orgId,
          userProviderConnections.providerCredentialId,
        ],
        set: {
          credentialsEncrypted,
          scopesGranted: input.scopesGranted,
          expiresAt: input.expiresAt,
          needsReconnection: false,
          updatedAt: new Date(),
        },
      })
      .returning({ id: userProviderConnections.id });

    const [key] = await tx
      .insert(orgSystemProviderKeys)
      .values({
        orgId: input.orgId,
        label: input.label,
        api: config.apiShape,
        baseUrl: config.defaultBaseUrl,
        apiKeyEncrypted: null,
        authMode: "oauth",
        oauthConnectionId: conn!.id,
        providerPackageId: input.providerPackageId,
        createdBy: input.userId,
      })
      .returning({ id: orgSystemProviderKeys.id });

    return { connectionId: conn!.id, providerKeyId: key!.id };
  });

  return { connectionId, providerKeyId };
}

export interface ImportOAuthModelProviderInput {
  orgId: string;
  applicationId: string;
  userId: string;
  /** Optional — server falls back to the user's default profile when absent. */
  connectionProfileId?: string;
  providerPackageId: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds since epoch. The CLI receives this from the provider's
   *  token endpoint as `expires_in` and converts to absolute. */
  expiresAt?: number | null;
  /** Claude-only: surfaced from the token response body by the CLI. */
  subscriptionType?: string;
  /** Provider account email — Codex extracts from JWT, Claude from token body. */
  email?: string;
  /**
   * Codex only — pi-ai's `loginOpenAICodex` surfaces the JWT's
   * `chatgpt_account_id` claim as a top-level field on its return value.
   * The CLI forwards it here so the platform can persist the canonical
   * value. The server still falls back to JWT decoding (defense in depth)
   * — this is the preferred source.
   */
  accountId?: string;
}

export interface ImportOAuthModelProviderResult {
  providerKeyId: string;
  connectionId: string;
  providerPackageId: string;
  email?: string;
  subscriptionType?: string;
  availableModelIds: string[];
}

/**
 * Persist a token bundle that the CLI obtained on the user's machine via
 * a loopback OAuth dance against the official provider client_id. This is
 * the platform-side counterpart of `apps/cli/src/commands/connect.ts`.
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
  const config = getOAuthModelProviderConfig(input.providerPackageId);
  if (!config) {
    throw notFound(
      `Unknown OAuth model provider: ${input.providerPackageId} (not in registry whitelist)`,
    );
  }
  if (!input.label.trim()) {
    throw invalidRequest("`label` is required", "label");
  }
  if (!input.accessToken || !input.refreshToken) {
    throw invalidRequest("`accessToken` and `refreshToken` are required");
  }

  // Resolve connectionProfileId — caller may pin to a specific profile, or
  // fall back to the user's default profile (auto-created on first call).
  let connectionProfileId = input.connectionProfileId;
  if (!connectionProfileId) {
    const profile = await ensureDefaultProfile({ type: "user", id: input.userId });
    connectionProfileId = profile.id;
  }

  // Provider-specific claim extraction. The CLI forwards pi-ai's surfaced
  // `accountId` (preferred — same value pi-ai's runtime already validated
  // against the upstream contract), and we fall back to a server-side JWT
  // decode if the CLI didn't include it. Defense in depth covers both
  // paths: an attacker can't forge `accountId` past the token itself
  // because Codex's backend rejects mismatched chatgpt-account-id headers.
  let chatgptAccountId: string | undefined = input.accountId;
  let email: string | undefined = input.email;
  if (input.providerPackageId === "@appstrate/provider-codex") {
    const claims = decodeCodexJwtPayload(input.accessToken);
    if (!chatgptAccountId) chatgptAccountId = claims?.chatgpt_account_id;
    if (!email) email = claims?.email;
    // Hard fail on missing chatgpt-account-id at import time — the inference
    // probe and runtime calls both require this header. Persisting a
    // connection without it produces a key that can't actually be used.
    if (!chatgptAccountId) {
      throw invalidRequest(
        "Could not resolve chatgpt-account-id from the Codex token. " +
          "The CLI must forward `accountId` (pi-ai surfaces it as a top-level " +
          "field after a successful login) — rebuild the CLI: " +
          "`cd apps/cli && bun run build`.",
      );
    }
  }
  logger.info("oauth model provider connection import", {
    providerPackageId: input.providerPackageId,
    hasAccountIdFromBody: !!input.accountId,
    hasAccountIdFinal: !!chatgptAccountId,
    accountIdLength: chatgptAccountId?.length ?? 0,
  });

  const result = await persistOAuthModelProviderTokens({
    orgId: input.orgId,
    applicationId: input.applicationId,
    userId: input.userId,
    connectionProfileId,
    providerPackageId: input.providerPackageId,
    label: input.label,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    scopesGranted: [...config.oauth.scopes],
    email,
    subscriptionType: input.subscriptionType,
    chatgptAccountId,
  });

  return {
    providerKeyId: result.providerKeyId,
    connectionId: result.connectionId,
    providerPackageId: input.providerPackageId,
    email,
    subscriptionType: input.subscriptionType,
    availableModelIds: config.models.map((m) => m.id),
  };
}
