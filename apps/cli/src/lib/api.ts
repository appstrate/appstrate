// SPDX-License-Identifier: Apache-2.0

/**
 * CLI → Appstrate API fetch wrapper.
 *
 * Authenticates by sending `Authorization: Bearer <jwt_access_token>`.
 * Since issue #165 the access token is a 15-minute ES256 JWT minted by
 * `/api/auth/cli/token`; the CLI silently rotates it via the stored
 * 30-day refresh token when:
 *
 *   - the access token is past (or within 30s of) its `expiresAt`
 *     BEFORE issuing the request (proactive refresh), OR
 *   - the request returns `401` (reactive refresh + single retry).
 *
 * Legacy 1.x credentials (no `refreshToken` on disk) skip both refresh
 * paths — the access token is sent as-is, and if the server rejects it
 * we surface an `AuthError` telling the user to re-run `appstrate
 * login`. This is the migration path called for by issue #165's
 * acceptance criteria.
 *
 * Inject `X-Org-Id` when the profile is pinned to a specific
 * organization — matches the dashboard SPA's header contract
 * (`apps/web/src/lib/api.ts`) so routes that use `requireOrgMembership`
 * work identically from the CLI.
 */

import { loadTokens, saveTokens, deleteTokens, type Tokens } from "./keyring.ts";
import { getProfile, type Profile } from "./config.ts";
import { normalizeInstance } from "./instance-url.ts";
import { CLI_USER_AGENT } from "./version.ts";
import { refreshCliTokens, DeviceFlowError } from "./device-flow.ts";

/**
 * Canonical clientId for the official CLI. Same constant lives in
 * `commands/login.ts` — kept in sync by test coverage over both files.
 * Duplication is deliberate: `api.ts` has no dependency on `commands/`,
 * and a single shared `const.ts` would be overkill for one string.
 */
const CLI_CLIENT_ID = "appstrate-cli";

/**
 * Refresh the access token proactively when it has this long or less
 * remaining. Avoids the case where we check `expiresAt > now`, send the
 * request, and the token expires in transit. 30 seconds comfortably
 * covers any realistic network round-trip + server-side verification
 * clock drift.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

async function resolveProfileOrThrow(profileName: string): Promise<Profile> {
  const profile = await getProfile(profileName);
  if (!profile) {
    throw new AuthError(
      `Profile "${profileName}" is not logged in. Run: appstrate login --profile ${profileName}`,
    );
  }
  return profile;
}

/**
 * Return a usable access token for `profileName`, silently rotating via
 * the stored refresh token when the access token is missing or about to
 * expire. Exported (prefixed `_`) for unit testing.
 *
 * Failure modes:
 *   - No tokens stored → `AuthError` ("run appstrate login").
 *   - Access expired, no refresh token (legacy session) → `AuthError`
 *     with a migration-specific message.
 *   - Access expired, refresh token also expired → clears local
 *     credentials, `AuthError`.
 *   - Refresh call returns `invalid_grant` (revoked, rotated, reused)
 *     → clears local credentials, `AuthError`.
 *   - Refresh call returns a transient error (network, 5xx) → the
 *     error bubbles as-is so the caller can report it without wiping
 *     the user's credentials for a server-side hiccup.
 */
export async function _resolveAccessTokenForTesting(
  profileName: string,
  profile: Profile,
): Promise<string> {
  return resolveAccessToken(profileName, profile);
}

async function resolveAccessToken(profileName: string, profile: Profile): Promise<string> {
  const tokens = await loadTokens(profileName);
  if (!tokens) {
    throw new AuthError(
      `No credentials for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
    );
  }
  const now = Date.now();
  const needsRefresh = tokens.expiresAt - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
  if (!needsRefresh) {
    return tokens.accessToken;
  }
  // Access token expired or imminent. Try refresh.
  return doRefresh(profileName, profile, tokens);
}

async function doRefresh(profileName: string, profile: Profile, tokens: Tokens): Promise<string> {
  if (!tokens.refreshToken) {
    // Legacy 1.x session or malformed store — cannot rotate. Wipe so a
    // subsequent invocation hits the "not logged in" branch instead of
    // re-retrying the same doomed refresh.
    await deleteTokens(profileName).catch(() => {});
    throw new AuthError(
      `Legacy session detected for profile "${profileName}" — 2.x auth requires a refresh token. Run: appstrate login --profile ${profileName}`,
    );
  }
  if (tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt <= Date.now()) {
    await deleteTokens(profileName).catch(() => {});
    throw new AuthError(
      `Refresh token expired for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
    );
  }
  try {
    const fresh = await refreshCliTokens(
      normalizeInstance(profile.instance),
      CLI_CLIENT_ID,
      tokens.refreshToken,
    );
    // Server must return a rotated refresh_token alongside the new
    // access token. If it didn't, we'd lose the ability to refresh on
    // the next cycle — treat that as a protocol error and force
    // re-login.
    if (!fresh.refreshToken) {
      await deleteTokens(profileName).catch(() => {});
      throw new AuthError(
        `Server did not return a rotated refresh_token for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
      );
    }
    const next: Tokens = {
      accessToken: fresh.accessToken,
      expiresAt: Date.now() + fresh.expiresIn * 1000,
      refreshToken: fresh.refreshToken,
      refreshExpiresAt:
        fresh.refreshExpiresIn !== undefined
          ? Date.now() + fresh.refreshExpiresIn * 1000
          : // If the server doesn't echo a refresh_expires_in, preserve
            // the original expiry — the upstream contract guarantees it
            // but defense-in-depth in the client prevents a stuck state.
            tokens.refreshExpiresAt,
    };
    await saveTokens(profileName, next);
    return next.accessToken;
  } catch (err) {
    if (err instanceof DeviceFlowError) {
      // `invalid_grant` is terminal (revoked / rotated / reused / expired).
      // Any other error code is transient — preserve the stored tokens so
      // the next invocation can try again.
      if (err.code === "invalid_grant") {
        await deleteTokens(profileName).catch(() => {});
        throw new AuthError(
          `Session for profile "${profileName}" is no longer valid (${err.code}). Run: appstrate login --profile ${profileName}`,
        );
      }
      throw err;
    }
    throw err;
  }
}

export interface ApiFetchInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

/**
 * Low-level authenticated fetch — primitive shared by `apiFetch` (JSON)
 * and direct callers that need access to the raw Response (streaming,
 * binary downloads, 204 sign-out). Resolves `profile.instance` + tokens
 * once, injects Authorization / X-Org-Id / User-Agent headers, and
 * returns the untouched fetch Response.
 *
 * Handles silent refresh transparently:
 *   - Proactively rotates when the access token is past its expiry
 *     margin BEFORE the first request.
 *   - Reactively rotates + retries once on 401. A second 401 after a
 *     fresh token surfaces to the caller.
 */
export async function apiFetchRaw(
  profileName: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<Response> {
  const profile = await resolveProfileOrThrow(profileName);
  const token = await resolveAccessToken(profileName, profile);

  const doFetch = async (bearer: string): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
      "User-Agent": CLI_USER_AGENT,
    };
    if (!headers["Content-Type"] && init.body) {
      headers["Content-Type"] = "application/json";
    }
    if (profile.orgId) headers["X-Org-Id"] = profile.orgId;
    return fetch(`${normalizeInstance(profile.instance)}${path}`, { ...init, headers });
  };

  const res = await doFetch(token);
  if (res.status !== 401) return res;

  // Reactive refresh: the server rejected our access token even though
  // we computed it as fresh. Common causes: clock skew, the BA JWKS
  // rotated mid-request, or the server revoked the underlying session.
  // Try ONE rotation + retry; a second 401 is terminal.
  const stored = await loadTokens(profileName);
  if (!stored || !stored.refreshToken) {
    return res;
  }
  let rotated: string;
  try {
    rotated = await doRefresh(profileName, profile, stored);
  } catch {
    // doRefresh already wiped credentials on terminal failures and
    // surfaces an AuthError — return the original 401 so the caller
    // sees the same shape as a non-refresh client would. The AuthError
    // path is reserved for cases where the CLI knows up-front there's
    // nothing to send.
    return res;
  }
  return doFetch(rotated);
}

/**
 * Authenticated JSON fetch. Parses 2xx bodies as JSON (204 → undefined),
 * translates 401 into a re-login `AuthError`, and every other non-2xx
 * into an `ApiError` carrying the parsed body + a best-effort message.
 */
export async function apiFetch<T>(
  profileName: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const res = await apiFetchRaw(profileName, path, init);

  if (res.status === 401) {
    throw new AuthError(
      `Unauthorized — your session may have been revoked. Run: appstrate login --profile ${profileName}`,
    );
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `HTTP ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
