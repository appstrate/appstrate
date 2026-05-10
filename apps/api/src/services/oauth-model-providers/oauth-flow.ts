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

const PROVIDER_TOKEN_URL: Record<string, string> = {
  "@appstrate/provider-codex": "https://auth.openai.com/oauth/token",
  "@appstrate/provider-claude-code": "https://claude.ai/v1/oauth/token",
};

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
  const tokenUrl = PROVIDER_TOKEN_URL[providerPackageId];
  if (!tokenUrl) {
    throw notFound(`No token URL registered for ${providerPackageId}. Update PROVIDER_TOKEN_URL.`);
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

  const credPayload: OAuthModelProviderCredentials = {
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
    token_type: "Bearer",
    ...(chatgpt_account_id ? { chatgpt_account_id } : {}),
    ...(subscription_type ? { subscription_type } : {}),
    ...(email ? { email } : {}),
  };

  // Persist: userProviderConnections (insert) + orgSystemProviderKeys (insert)
  // in a transaction so a half-baked state never gets exposed.
  const providerCredentialId = await ensureProviderCredentialRow(
    stateRow.applicationId,
    providerPackageId,
    config,
  );
  const credentialsEncrypted = encryptCredentials(
    credPayload as unknown as Record<string, unknown>,
  );
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  const { connectionId, providerKeyId } = await db.transaction(async (tx) => {
    const [conn] = await tx
      .insert(userProviderConnections)
      .values({
        connectionProfileId: stateRow.connectionProfileId,
        providerId: providerPackageId,
        orgId: stateRow.orgId,
        providerCredentialId,
        credentialsEncrypted,
        scopesGranted: parsed.scopesGranted,
        expiresAt,
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
          scopesGranted: parsed.scopesGranted,
          expiresAt,
          needsReconnection: false,
          updatedAt: new Date(),
        },
      })
      .returning({ id: userProviderConnections.id });

    const [key] = await tx
      .insert(orgSystemProviderKeys)
      .values({
        orgId: stateRow.orgId,
        label,
        api: config.api.apiShape,
        baseUrl: config.api.baseUrl,
        apiKeyEncrypted: null,
        authMode: "oauth",
        oauthConnectionId: conn!.id,
        providerPackageId,
        createdBy: stateRow.userId,
      })
      .returning({ id: orgSystemProviderKeys.id });

    return { connectionId: conn!.id, providerKeyId: key!.id };
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
