// SPDX-License-Identifier: Apache-2.0

/**
 * CLI → Appstrate API fetch wrapper.
 *
 * Authenticates by sending `Authorization: Bearer <jwt_access_token>`.
 * The access token is a 15-minute ES256 JWT minted by
 * `/api/auth/cli/token`; the CLI silently rotates it via the stored
 * 30-day refresh token when:
 *
 *   - the access token is past (or within 30s of) its `expiresAt`
 *     BEFORE issuing the request (proactive refresh), OR
 *   - the request returns `401` (reactive refresh + single retry).
 *
 * Inject `X-Org-Id` + `X-App-Id` when the profile is pinned to a
 * specific organization / application — matches the dashboard SPA's
 * header contract (`apps/web/src/lib/api.ts`) so routes that use
 * `requireOrgMembership` + `requireAppContext` work identically from
 * the CLI.
 */

import { loadTokens, saveTokens, deleteTokens, type Tokens } from "./keyring.ts";
import { getProfile, type Profile } from "./config.ts";
import { normalizeInstance } from "./instance-url.ts";
import { CLI_USER_AGENT } from "./version.ts";
import { refreshCliTokens, DeviceFlowError } from "./device-flow.ts";
import { CLI_CLIENT_ID } from "./cli-client.ts";

/**
 * Refresh the access token proactively when it has this long or less
 * remaining. Avoids the case where we check `expiresAt > now`, send the
 * request, and the token expires in transit. 30 seconds comfortably
 * covers any realistic network round-trip + server-side verification
 * clock drift.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30_000;

/**
 * Per-profile in-flight refresh dedup.
 *
 * When a CLI invocation issues parallel API calls (batch operations,
 * SSE + REST, stream + poll), each call independently resolves the
 * access token and can independently react to a 401. Without this
 * mutex, two callers would read the same plaintext refresh token from
 * the keyring and POST it concurrently to `/cli/token`: the server
 * rotates the first, marks it `used_at`, and the second trips the
 * RFC 6819 §5.2.2.3 reuse-detection branch that revokes the ENTIRE
 * family — booting the legitimate user for what is effectively our
 * own race.
 *
 * Sharing a single `Promise<string>` per profile collapses all
 * concurrent refreshes for that profile into a single server round-
 * trip: every caller observes the same rotated access token. The
 * entry is cleared in `.finally()` so the next bona-fide rotation
 * (15 min later) starts fresh.
 *
 * ## Known limitation — cross-process races (PR #191 review)
 *
 * This mutex is in-process only. Two CLI invocations running in
 * PARALLEL PROCESSES (e.g. `xargs -P N appstrate …`, concurrent CI
 * jobs sharing a keyring, a user running two commands in separate
 * shells) each maintain their own empty `inFlightRefresh` map. If
 * both enter their proactive-refresh window at the same time, each
 * reads the same plaintext refresh token from the keyring and POSTs
 * it to `/cli/token` — one wins, the other trips reuse detection,
 * and the family gets revoked (RFC 6819 §5.2.2.3). The legitimate
 * user is then booted and has to re-run `appstrate login`.
 *
 * A file lock around the resolve+save sequence in `loadTokens` /
 * `saveTokens` (advisory `flock()` on the fallback file, or
 * process-local locking on the keyring entry) would close this
 * window. Left as a follow-up because:
 *   1. The common CLI use case is sequential — each command finishes
 *      before the next starts.
 *   2. When it does fire, the user sees a clean re-auth prompt (the
 *      reactive 401 branch wipes local credentials), not a silent
 *      security incident.
 *   3. The family revocation IS the correct defense if the token was
 *      ever actually leaked; degrading to "accept predecessor" would
 *      trade cross-process ergonomics for a real replay window.
 */
const inFlightRefresh = new Map<string, Promise<string>>();

function withRefreshLock(profileName: string, fn: () => Promise<string>): Promise<string> {
  const existing = inFlightRefresh.get(profileName);
  if (existing) return existing;
  const promise = fn().finally(() => {
    inFlightRefresh.delete(profileName);
  });
  inFlightRefresh.set(profileName, promise);
  return promise;
}

// Test-only surface: lets the unit tests assert dedup behavior without
// exposing the map to production callers.
export function _inFlightRefreshSizeForTesting(): number {
  return inFlightRefresh.size;
}

/**
 * Block until any in-flight refresh for `profileName` has settled. Used
 * by `appstrate logout` to prevent the classic "refresh resurrects the
 * tokens we just deleted" race: if a parallel `apiFetchRaw` is mid-
 * rotation when logout fires, its trailing `saveTokens` would write
 * fresh credentials onto disk AFTER `deleteTokens` ran, effectively
 * un-logging-out the user. Awaiting the promise (error-swallowed —
 * logout doesn't care whether the refresh succeeded) lets logout
 * sequence its final delete after the rotation commits or bails.
 */
export async function _awaitRefreshQuiesce(profileName: string): Promise<void> {
  const p = inFlightRefresh.get(profileName);
  if (p) await p.catch(() => {});
}

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

export interface AuthContext {
  instance: string;
  accessToken: string;
  orgId?: string;
  appId?: string;
}

/**
 * One-shot resolver used by pass-through commands (`appstrate api`) that
 * need the instance URL + a fresh bearer but cannot go through
 * `apiFetchRaw` — typically because they own their own redirect / TLS /
 * body-stream semantics and would be broken by `apiFetchRaw`'s reactive
 * 401 retry (which replays a body that may have already been consumed).
 *
 * All the silent-refresh machinery (per-profile mutex, proactive margin,
 * keyring scrub on invalid_grant) is reused — this is purely a composer
 * over the existing internals.
 */
export async function resolveAuthContext(profileName: string): Promise<AuthContext> {
  const profile = await resolveProfileOrThrow(profileName);
  const token = await resolveAccessToken(profileName, profile);
  return {
    instance: normalizeInstance(profile.instance),
    accessToken: token,
    orgId: profile.orgId,
    appId: profile.appId,
  };
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
  // Access token expired or imminent. Try refresh — dedup via the
  // per-profile mutex so parallel callers don't race the refresh
  // token against server-side reuse detection.
  return withRefreshLock(profileName, () => doRefresh(profileName, profile, tokens));
}

async function doRefresh(profileName: string, profile: Profile, tokens: Tokens): Promise<string> {
  if (tokens.refreshExpiresAt <= Date.now()) {
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
    if (profile.appId) headers["X-App-Id"] = profile.appId;
    return fetch(`${normalizeInstance(profile.instance)}${path}`, { ...init, headers });
  };

  const res = await doFetch(token);
  if (res.status !== 401) return res;

  // Reactive refresh: the server rejected our access token even though
  // we computed it as fresh. Common causes: clock skew, the BA JWKS
  // rotated mid-request, or the server revoked the underlying session.
  // Try ONE rotation + retry; a second 401 is terminal.
  const stored = await loadTokens(profileName);
  if (!stored) {
    return res;
  }
  // If a parallel caller already rotated the token between our initial
  // resolve and this 401, the keyring now holds a newer access token.
  // Retry with it first — we'd otherwise burn a refresh-token rotation
  // for nothing, and in edge timing could even race the mutex into
  // unnecessary network calls.
  if (stored.accessToken !== token) {
    const retry = await doFetch(stored.accessToken);
    if (retry.status !== 401) return retry;
  }
  let rotated: string;
  try {
    rotated = await withRefreshLock(profileName, () => doRefresh(profileName, profile, stored));
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

/**
 * Authenticated reader for Stripe-canonical list endpoints
 * (`{ object: "list", data: T[], hasMore, total? }`). Returns the
 * unwrapped `data` array so callers don't repeat the envelope shape
 * inline.
 *
 * Mirrors `apps/web/src/api.ts::apiList<T>` and the
 * `PlatformListResponse<T>` contract in `@appstrate/core/platform-types`.
 *
 * Strict by design: a payload missing `data` or whose `data` is not an
 * array trips `ApiError(500, …)` instead of silently returning `[]`.
 * The platform always emits the canonical envelope via
 * `apps/api/src/lib/list-response.ts`, so a degenerate shape is a real
 * server-side bug and surfacing it loudly beats hiding it.
 */
export async function apiList<T>(
  profileName: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<T[]> {
  const envelope = await apiFetch<{ data?: unknown }>(profileName, path, init);
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.data)) {
    throw new ApiError(
      500,
      `Malformed list response from ${path}: expected { object: "list", data: [...] }.`,
      envelope,
    );
  }
  return envelope.data as T[];
}
