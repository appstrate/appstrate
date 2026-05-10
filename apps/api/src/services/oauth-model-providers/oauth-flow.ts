// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — initiate + callback flow.
 *
 * Parallel to `services/connection-manager/oauth.ts` but specialized for
 * public PKCE clients (Codex, Claude Code) with no `client_secret`. The
 * official flow in @appstrate/connect requires a secret (read from
 * `applicationProviderCredentials`); we read `clientId` from the runtime
 * registry and skip the secret entirely.
 *
 * The persisted shape is the same — `userProviderConnections` rows, an
 * `applicationProviderCredentials` row (auto-seeded with empty secret as
 * a placeholder), and an `orgSystemProviderKeys` row in `authMode='oauth'`.
 *
 * Spec: docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §4.
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationProviderCredentials,
  orgSystemProviderKeys,
  userProviderConnections,
} from "@appstrate/db/schema";
import {
  encryptCredentials,
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "@appstrate/connect";
import { ensureDefaultProfile } from "../connection-profiles.ts";
import {
  getOAuthModelProviderConfig,
  isOAuthModelProvider,
  OAUTH_MODEL_PROVIDER_TOKEN_URLS,
  type OAuthModelProviderConfig,
} from "./registry.ts";
import {
  decodeCodexJwtPayload,
  readClaudeEmail,
  readClaudeSubscriptionType,
  type OAuthModelProviderCredentials,
} from "./credentials.ts";
import { invalidRequest, notFound } from "../../lib/errors.ts";
import { oauthStateStore } from "../connection-manager/oauth-state-store.ts";
import type { OAuthStateRecord } from "@appstrate/connect";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const PROVIDER_AUTHORIZATION_URL: Record<string, string> = {
  "@appstrate/provider-codex": "https://auth.openai.com/oauth/authorize",
  "@appstrate/provider-claude-code": "https://claude.ai/oauth/authorize",
};

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

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
    clientId: registryConfig.clientId,
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
  /**
   * The user attributed for the connection. Nullable because the legacy
   * authorization-code flow's `OAuthStateRecord` allows null user (other
   * actor types reuse the same store), even though the model-provider
   * route guards always set it. The DB column is nullable to match.
   */
  userId: string | null;
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
 * Both entry points (the legacy callback and the new CLI-driven `/import`)
 * funnel through this helper to keep the persisted shape exactly identical
 * — the sidecar's token cache + refresh worker are written against the
 * shape this function produces and must not see drift.
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
        api: config.api.apiShape,
        baseUrl: config.api.baseUrl,
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

export interface InitiateOAuthModelProviderInput {
  orgId: string;
  applicationId: string;
  userId: string;
  providerPackageId: string;
  label: string;
  redirectUri: string;
}

export interface InitiateOAuthModelProviderResult {
  authorizationUrl: string;
  state: string;
}

/**
 * Initiate the OAuth flow for a model provider. Idempotent w.r.t.
 * `applicationProviderCredentials` (auto-seeds row if absent) and the
 * user's default `connectionProfile` (creates one if missing).
 *
 * Throws `invalidRequest`/`notFound` on user-facing errors so the route
 * can return RFC 9457 responses without re-mapping.
 */
export async function initiateOAuthModelProviderConnection(
  input: InitiateOAuthModelProviderInput,
): Promise<InitiateOAuthModelProviderResult> {
  const config = getOAuthModelProviderConfig(input.providerPackageId);
  if (!config) {
    throw notFound(
      `Unknown OAuth model provider: ${input.providerPackageId} (not in registry whitelist)`,
    );
  }
  if (!input.label.trim()) {
    throw invalidRequest("`label` is required", "label");
  }

  const authorizationUrl = PROVIDER_AUTHORIZATION_URL[input.providerPackageId];
  if (!authorizationUrl) {
    throw notFound(
      `No authorization URL registered for ${input.providerPackageId}. Update PROVIDER_AUTHORIZATION_URL.`,
    );
  }

  const profile = await ensureDefaultProfile({ type: "user", id: input.userId });
  await ensureProviderCredentialRow(input.applicationId, input.providerPackageId, config);

  const state = crypto.randomUUID();
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  // Reuse the platform's OAuthStateRecord shape so the state store schema
  // stays homogeneous. `authMode: "oauth2"` + `connectionProfileId` are
  // the load-bearing fields; everything else is positional.
  const record: OAuthStateRecord = {
    state,
    orgId: input.orgId,
    userId: input.userId,
    endUserId: null,
    applicationId: input.applicationId,
    connectionProfileId: profile.id,
    providerId: input.providerPackageId,
    codeVerifier,
    scopesRequested: [...config.scopes],
    redirectUri: input.redirectUri,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
    authMode: "oauth2",
    // Custom payload — discriminates this state row from regular integration
    // OAuth flows during the shared callback handling. The `metadata` field is
    // a free-form bag in `OAuthStateRecord`; we tag it so the callback router
    // can route to our handler.
    metadata: {
      kind: "oauth_model_provider",
      providerPackageId: input.providerPackageId,
      label: input.label,
    },
  };
  await oauthStateStore.set(state, record, OAUTH_STATE_TTL_SECONDS);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state,
    scope: config.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: config.pkce,
  });

  return {
    authorizationUrl: `${authorizationUrl}?${params.toString()}`,
    state,
  };
}

export interface OAuthModelProviderCallbackInput {
  code: string;
  state: string;
}

export interface OAuthModelProviderCallbackResult {
  providerKeyId: string;
  connectionId: string;
  providerPackageId: string;
  email?: string;
  subscriptionType?: string;
  /** Comma-separated list of `id`s available for one-click `org_models` creation. */
  availableModelIds: string[];
}

/**
 * Handle the OAuth callback for a model provider. Exchanges the code,
 * decodes provider-specific claims, and creates the persistence chain
 * (`userProviderConnections` + `orgSystemProviderKeys`) in a single
 * transaction so a partial failure leaves no orphan rows.
 *
 * Throws `invalidRequest`/`notFound` for user-recoverable failures and
 * `Error` for systemic ones (network, decryption, etc.).
 */
export async function handleOAuthModelProviderCallback(
  input: OAuthModelProviderCallbackInput,
): Promise<OAuthModelProviderCallbackResult> {
  const stateRow = await oauthStateStore.get(input.state);
  if (!stateRow) {
    throw invalidRequest("Invalid or expired OAuth state", "state");
  }
  const meta = stateRow.metadata;
  if (!meta || meta["kind"] !== "oauth_model_provider") {
    throw invalidRequest("State is not for an OAuth model provider flow", "state");
  }
  const providerPackageId = meta["providerPackageId"] as string | undefined;
  const label = (meta["label"] as string | undefined) ?? "OAuth model provider";
  if (!providerPackageId || !isOAuthModelProvider(providerPackageId)) {
    throw notFound(`Unknown OAuth model provider in state: ${providerPackageId ?? "<missing>"}`);
  }

  const config = getOAuthModelProviderConfig(providerPackageId)!;
  const tokenUrl = OAUTH_MODEL_PROVIDER_TOKEN_URLS[providerPackageId];
  if (!tokenUrl) {
    throw notFound(
      `No token URL registered for ${providerPackageId}. Update OAUTH_MODEL_PROVIDER_TOKEN_URLS.`,
    );
  }

  // Public PKCE client — no client_secret. Send only client_id + verifier.
  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: stateRow.redirectUri,
    client_id: config.clientId,
    code_verifier: stateRow.codeVerifier,
  };

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(undefined, config.clientId, "", undefined),
      body: buildTokenBody(tokenParams),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Token exchange network error for '${providerPackageId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    const classification = parseTokenErrorResponse(tokenResponse.status, text);
    if (classification.kind === "revoked") {
      // Auth code is dead — clean state row, surface invalid_grant
      try {
        await oauthStateStore.delete(input.state);
      } catch {
        /* swallowed: TTL will reap */
      }
    }
    throw invalidRequest(
      `Token exchange failed for '${providerPackageId}': ${
        classification.error ?? `HTTP ${tokenResponse.status}`
      }`,
    );
  }

  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await tokenResponse.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Token exchange returned non-JSON response for '${providerPackageId}'`);
  }

  const parsed = parseTokenResponse(tokenData, [...config.scopes]);
  if (!parsed.refreshToken) {
    // Both Codex and Claude return refresh tokens — absence is a sign of a
    // misconfiguration (wrong scopes / wrong client_id).
    throw new Error(
      `Token response missing refresh_token for '${providerPackageId}' — likely a scope or client_id misconfiguration`,
    );
  }

  // Provider-specific claim extraction
  let chatgpt_account_id: string | undefined;
  let email: string | undefined;
  let subscription_type: string | undefined;
  if (providerPackageId === "@appstrate/provider-codex") {
    const claims = decodeCodexJwtPayload(parsed.accessToken);
    chatgpt_account_id = claims?.chatgpt_account_id;
    email = claims?.email;
  } else if (providerPackageId === "@appstrate/provider-claude-code") {
    subscription_type = readClaudeSubscriptionType(tokenData);
    email = readClaudeEmail(tokenData);
  }

  const { connectionId, providerKeyId } = await persistOAuthModelProviderTokens({
    orgId: stateRow.orgId,
    applicationId: stateRow.applicationId,
    userId: stateRow.userId,
    connectionProfileId: stateRow.connectionProfileId,
    providerPackageId,
    label,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
    scopesGranted: parsed.scopesGranted,
    email,
    subscriptionType: subscription_type,
    chatgptAccountId: chatgpt_account_id,
  });

  await oauthStateStore.delete(input.state);

  return {
    providerKeyId,
    connectionId,
    providerPackageId,
    email,
    subscriptionType: subscription_type,
    availableModelIds: config.models.map((m) => m.id),
  };
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
 * The CLI cannot use `/initiate` + `/callback` because the public client_ids
 * baked into Codex / Claude Code only allowlist the loopback `redirect_uri`s
 * their own CLIs use (`http://localhost:1455/auth/callback` and
 * `http://localhost:53692/callback`). Any platform-hosted callback URL is
 * rejected by the provider's authorization server. So we delegate the
 * loopback dance to the user's terminal via `@mariozechner/pi-ai`, receive
 * the resulting tokens, and persist them via the same helper the legacy
 * callback used.
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

  // Provider-specific claim extraction. We re-run JWT decoding server-side
  // for Codex even though the CLI saw the same token — the JWT is signed by
  // OpenAI, so reading `chatgpt_account_id` from it is the canonical move.
  let chatgptAccountId: string | undefined;
  let email: string | undefined = input.email;
  if (input.providerPackageId === "@appstrate/provider-codex") {
    const claims = decodeCodexJwtPayload(input.accessToken);
    chatgptAccountId = claims?.chatgpt_account_id;
    if (!email) email = claims?.email;
  }

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
    scopesGranted: [...config.scopes],
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
