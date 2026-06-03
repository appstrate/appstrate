// SPDX-License-Identifier: Apache-2.0

/**
 * Test-credential resolution for the live tiers (remote MCP parity,
 * auth-liveness). Opt-in: a package is only exercised live when a credential
 * is present, otherwise its handler degrades to a SKIP/WARN.
 *
 * `CONFORMANCE_TOKENS` is a JSON object mapping package id → credential, where
 * each value is one of:
 *
 *   - a bearer **access token** string (simplest; works while it is valid):
 *       {"@appstrate/notion-mcp":"secret_...","@appstrate/stripe":"sk_test_..."}
 *
 *   - a **refresh credential** object (self-renewing — for short-lived tokens
 *     like Google's 1h access tokens, so the weekly cron keeps coverage):
 *       {"@appstrate/google-calendar":{"refresh_token":"...","client_id":"...",
 *         "client_secret":"...","token_endpoint":"https://oauth2.googleapis.com/token"}}
 *     A fresh access token is minted per run via `grant_type=refresh_token`.
 *     `client_secret` + `token_endpoint_auth_method` are required for
 *     confidential clients (Google = client_secret_post). `token_endpoint`
 *     skips discovery; otherwise it is discovered from the manifest issuer.
 *
 * Most providers issue long-lived/non-expiring tokens (string form is enough);
 * Google is the one that needs the refresh form (and survives the cron).
 *
 * Two providers can NOT be covered by a static cron secret → manual
 * `workflow_dispatch` only (grab a fresh credential per run via grab-token):
 *   - ClickUp: issues no refresh token at all.
 *   - Notion MCP: issues a ROTATING refresh token (OAuth 2.1 — each refresh
 *     invalidates the prior one with replay detection). A stored secret works
 *     exactly once, then the server rotates it and the next run replays the
 *     dead token → `invalid_grant: Refresh token reuse detected`. Self-renewal
 *     would require persisting the rotated token back into the secret each run.
 */

import { resolveOAuthEndpoints, performRefreshTokenExchange } from "@appstrate/connect";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";

const ENV_KEY = "CONFORMANCE_TOKENS";

/** A refresh credential — mints a fresh access token each run. */
export interface RefreshCredential {
  refresh_token: string;
  client_id: string;
  /** Required for confidential clients (client_secret_*), e.g. Google. */
  client_secret?: string;
  /** Token-endpoint auth method; defaults to public client ("none"). */
  token_endpoint_auth_method?: string;
  /** Optional: skip discovery and use this token endpoint directly. */
  token_endpoint?: string;
}

type Credential = string | RefreshCredential;

let cache: Record<string, Credential> | null = null;
const accessTokenCache = new Map<string, string>();

function isRefreshCredential(v: unknown): v is RefreshCredential {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as RefreshCredential).refresh_token === "string" &&
    typeof (v as RefreshCredential).client_id === "string"
  );
}

/** Parse `CONFORMANCE_TOKENS` once. Invalid JSON → empty map. */
function load(): Record<string, Credential> {
  if (cache) return cache;
  const raw = process.env[ENV_KEY];
  const map: Record<string, Credential> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && v.length > 0) map[k] = v;
          else if (isRefreshCredential(v)) map[k] = v;
        }
      }
    } catch {
      // invalid JSON → empty map
    }
  }
  cache = map;
  return cache;
}

/** Raw bearer string when the credential is a plain token, else undefined. */
export function resolveToken(packageId: string): string | undefined {
  const cred = load()[packageId];
  return typeof cred === "string" ? cred : undefined;
}

/** Number of configured credentials (string or refresh form). */
export function credentialedCount(): number {
  return Object.keys(load()).length;
}

/** First auth issuer declared by the manifest (for refresh-token discovery). */
function manifestIssuer(manifest: Record<string, unknown>): string | undefined {
  const auths = manifest.auths;
  if (auths && typeof auths === "object") {
    for (const auth of Object.values(auths as Record<string, unknown>)) {
      const issuer = (auth as { issuer?: unknown })?.issuer;
      if (typeof issuer === "string") return issuer;
    }
  }
  return undefined;
}

export interface ResolveDeps {
  resolveEndpoints?: typeof resolveOAuthEndpoints;
  exchange?: typeof performRefreshTokenExchange;
}

/**
 * Resolve a usable bearer access token for a package. Plain-string credentials
 * are returned as-is; refresh credentials are exchanged for a fresh access
 * token (cached for the run). Returns undefined when no credential exists.
 */
export async function resolveAccessToken(
  entry: SystemPackageEntry,
  deps: ResolveDeps = {},
): Promise<string | undefined> {
  const cred = load()[entry.packageId];
  if (!cred) return undefined;
  if (typeof cred === "string") return cred;

  const cached = accessTokenCache.get(entry.packageId);
  if (cached) return cached;

  let tokenEndpoint = cred.token_endpoint;
  if (!tokenEndpoint) {
    const issuer = manifestIssuer(entry.manifest);
    if (!issuer) {
      throw new Error(
        `${entry.packageId}: refresh credential needs a token_endpoint or a manifest issuer`,
      );
    }
    const resolveEndpoints = deps.resolveEndpoints ?? resolveOAuthEndpoints;
    const ep = await resolveEndpoints({ issuer });
    if (!ep.tokenEndpoint) {
      throw new Error(`${entry.packageId}: could not discover token endpoint from ${issuer}`);
    }
    tokenEndpoint = ep.tokenEndpoint;
  }

  const exchange = deps.exchange ?? performRefreshTokenExchange;
  const tokenEndpointAuthMethod = (cred.token_endpoint_auth_method ?? "none") as Parameters<
    typeof performRefreshTokenExchange
  >[0]["tokenEndpointAuthMethod"];
  const result = await exchange(
    {
      tokenEndpoint,
      clientId: cred.client_id,
      clientSecret: cred.client_secret ?? "",
      tokenEndpointAuthMethod,
    },
    cred.refresh_token,
    { label: `conformance:${entry.packageId}` },
  );
  const access = result.raw.access_token;
  if (typeof access !== "string" || !access) {
    throw new Error(`${entry.packageId}: refresh exchange returned no access_token`);
  }
  accessTokenCache.set(entry.packageId, access);
  return access;
}

/** Reset caches (tests). */
export function _resetCredsCache(): void {
  cache = null;
  accessTokenCache.clear();
}
