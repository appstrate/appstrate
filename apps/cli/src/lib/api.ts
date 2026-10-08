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
 * Both go through `refreshAccessToken`, which serializes rotations within
 * the process and across processes (the refresh token is single-use).
 *
 * Inject `X-Org-Id` + `X-Space-Id` when the profile is pinned to a
 * specific organization / space — matches the dashboard SPA's
 * header contract (`apps/web/src/lib/api.ts`) so routes that use
 * `requireOrgMembership` + `requireSpaceContext` work identically from
 * the CLI.
 */

import { join } from "node:path";
import { loadTokens, saveTokens, deleteTokens, type Tokens } from "./keyring.ts";
import { getConfigDir, getProfile, resolveActiveProfileOrNull, type Profile } from "./config.ts";
import { withFileLock } from "./file-lock.ts";
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
 * Bounds the wait for another process's refresh. The holder makes one HTTP
 * call, so a longer wait means it hung: give up with `FileLockBusyError`,
 * which leaves the stored credentials for the next command.
 */
const REFRESH_LOCK_TIMEOUT_MS = 30_000;

/**
 * Below the lock's 500 ms default: the critical section is one HTTP call, and
 * every process that lost the race waits on it before its own command runs.
 */
const REFRESH_LOCK_POLL_MS = 100;

/**
 * One lock for every profile: serializing refreshes of different profiles
 * costs a round-trip at worst, and a profile name never has to become a path.
 * In the config dir, beside `credentials.json`, because it guards credentials.
 */
export function getRefreshLockPath(): string {
  return join(getConfigDir(), "token-refresh.lock");
}

/**
 * Per-profile in-flight refresh dedup, in front of the cross-process lock.
 *
 * When a CLI invocation issues parallel API calls (batch operations,
 * SSE + REST, stream + poll), each call independently resolves the
 * access token and can independently react to a 401. Sharing a single
 * `Promise<string>` per profile collapses all concurrent refreshes for
 * that profile into one lock acquisition and at most one server
 * round-trip: every caller observes the same rotated access token. The
 * entry is cleared in `.finally()` so the next bona-fide rotation
 * (15 min later) starts fresh.
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

/**
 * The RFC 9457 `code` and `detail` of an error body, whichever are there — an
 * {@link ApiError}'s `body`, or a raw response's parsed JSON. The one parser
 * every caller that switches on a problem `code` goes through.
 */
export function problemFields(body: unknown): { code?: string; detail?: string } {
  if (!body || typeof body !== "object") return {};
  const { code, detail } = body as { code?: unknown; detail?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
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

interface AuthContext {
  instance: string;
  accessToken: string;
  orgId?: string;
  spaceId?: string;
}

/**
 * One-shot resolver used by pass-through commands (`appstrate api`) that
 * need the instance URL + a fresh bearer but cannot go through
 * `apiFetchRaw` — typically because they own their own redirect / TLS /
 * body-stream semantics and would be broken by `apiFetchRaw`'s reactive
 * 401 retry (which replays a body that may have already been consumed).
 *
 * All the silent-refresh machinery (refresh locks, proactive margin,
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
    spaceId: profile.spaceId,
  };
}

/** The `--api-key` flag, else `APPSTRATE_API_KEY` (empty env = unset). */
export function explicitApiKey(flag: string | undefined): string | undefined {
  const key = (flag ?? process.env.APPSTRATE_API_KEY)?.trim();
  if (!key) {
    // An explicitly passed empty flag (`--api-key "$UNSET_VAR"`) must not
    // degrade to the profile's full-authority credential.
    if (flag !== undefined) throw new AuthError("--api-key is empty");
    return undefined;
  }
  // A CR/LF, NUL or non-Latin-1 character makes `fetch` throw an error that
  // quotes the key; deliberately stricter (visible ASCII), and never echoed.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new AuthError(
      "The API key contains whitespace, a line break or a non-ASCII character. Check --api-key / APPSTRATE_API_KEY.",
    );
  }
  return key;
}

/**
 * `APPSTRATE_INSTANCE`, else the profile's instance; a key needs no profile. Nothing
 * else is read off the profile: its org and space pins would contradict the key's.
 */
export async function resolveApiKeyTarget(
  profileFlag: string | undefined,
): Promise<{ instance: string | undefined }> {
  const profile = (await resolveActiveProfileOrNull(profileFlag))?.profile;
  return { instance: process.env.APPSTRATE_INSTANCE || profile?.instance };
}

/**
 * `resolveAuthContext` for an explicit API key. No `orgId` / `spaceId`:
 * the key pins both server-side and the platform answers 403 to a header
 * that disagrees, so the profile's pins would break a valid key.
 */
export async function resolveApiKeyAuthContext(
  apiKey: string,
  profileFlag: string | undefined,
): Promise<AuthContext> {
  const { instance } = await resolveApiKeyTarget(profileFlag);
  if (!instance) {
    throw new AuthError(
      "No Appstrate instance URL for the API key. Set APPSTRATE_INSTANCE, or run `appstrate login` to pin a profile.",
    );
  }
  try {
    return { instance: normalizeInstance(instance), accessToken: apiKey };
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : String(err));
  }
}

function noCredentials(profileName: string): AuthError {
  return new AuthError(
    `No credentials for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
  );
}

async function resolveAccessToken(profileName: string, profile: Profile): Promise<string> {
  const tokens = await loadTokens(profileName);
  if (!tokens) throw noCredentials(profileName);
  const now = Date.now();
  const needsRefresh = tokens.expiresAt - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
  if (!needsRefresh) {
    return tokens.accessToken;
  }
  return refreshAccessToken(profileName, profile, tokens);
}

/**
 * Rotate the pair the caller read (`seen`) and return the new access token.
 *
 * A refresh token is single-use: presenting one twice trips RFC 6819
 * §5.2.2.3 reuse detection, which revokes the whole family and logs the
 * user out. Concurrent `appstrate` processes are routine — Claude Code runs
 * `code sync` in the background at every session start, beside whatever
 * else is calling the CLI — so read → refresh → save runs under a `flock(2)`
 * every process shares. Serializing the HTTP calls alone is not enough: a
 * process that read the pair before waiting would still present the stale
 * token. So the pair is re-read under the lock, and a refresh token other
 * than `seen` means another process rotated meanwhile: its access token is
 * the answer, with no call to the server.
 *
 * Where `flock` is unavailable the lock fails open silently: the user cannot
 * act on a warning about refreshes they never asked for.
 */
function refreshAccessToken(profileName: string, profile: Profile, seen: Tokens): Promise<string> {
  return withRefreshLock(profileName, () =>
    withFileLock(
      getRefreshLockPath(),
      "token refresh",
      async () => {
        const current = await loadTokens(profileName);
        if (!current) throw noCredentials(profileName);
        if (current.refreshToken !== seen.refreshToken) return current.accessToken;
        return doRefresh(profileName, profile, current);
      },
      { timeoutMs: REFRESH_LOCK_TIMEOUT_MS, pollMs: REFRESH_LOCK_POLL_MS, warnUnlocked: false },
    ),
  );
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

interface ApiFetchInit extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  /** Explicit space selection without changing the active profile. */
  spaceId?: string;
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

  const { spaceId: explicitSpaceId, ...requestInit } = init;
  const doFetch = async (bearer: string): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${bearer}`,
      "User-Agent": CLI_USER_AGENT,
    };
    // Case-insensitive probe: a caller passing a lowercase `content-type`
    // header would otherwise slip past a bare `headers["Content-Type"]`
    // lookup and we'd add a SECOND, conflicting content-type entry.
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    // Strings only: a `FormData` body gets its multipart boundary from
    // `fetch`, and a forced JSON type would erase it.
    if (!hasContentType && typeof init.body === "string") {
      headers["Content-Type"] = "application/json";
    }
    if (profile.orgId) headers["X-Org-Id"] = profile.orgId;
    const spaceId = explicitSpaceId ?? profile.spaceId;
    if (spaceId) headers["X-Space-Id"] = spaceId;
    return fetch(`${normalizeInstance(profile.instance)}${path}`, { ...requestInit, headers });
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
  // for nothing.
  if (stored.accessToken !== token) {
    const retry = await doFetch(stored.accessToken);
    if (retry.status !== 401) return retry;
  }
  let rotated: string;
  try {
    rotated = await refreshAccessToken(profileName, profile, stored);
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
  return (await apiFetchWithHeaders<T>(profileName, path, init)).body;
}

/** {@link apiFetch}, keeping the response headers — an `ETag` to send back as `If-Match`. */
export async function apiFetchWithHeaders<T>(
  profileName: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<{ body: T; headers: Headers }> {
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
    // The platform answers RFC 9457 (`detail`); Better Auth's endpoints answer
    // `{ message }`. Two producers, two shapes — each read as what it is.
    const message =
      problemFields(body).detail ??
      (body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `HTTP ${res.status} ${res.statusText}`);
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return { body: undefined as T, headers: res.headers };
  return { body: (await res.json()) as T, headers: res.headers };
}

/**
 * Authenticated reader for Stripe-canonical list endpoints
 * (`{ object: "list", data: T[], hasMore, total? }`). Returns the
 * unwrapped `data` array so callers don't repeat the envelope shape
 * inline.
 *
 * Mirrors `apps/web/src/api.ts::apiList<T>` and the canonical
 * list-envelope contract (`{ object, data, hasMore }`).
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
