// SPDX-License-Identifier: Apache-2.0

/**
 * CLI → Appstrate API fetch wrapper.
 *
 * Authenticates by sending `Authorization: Bearer <raw_session_token>`.
 * The CLI's access token is a raw BA session token (opaque string, not a
 * JWT — preflight PF-3). Without the BA `bearer()` plugin wired
 * server-side, this header would be ignored because BA's default auth
 * pipeline only honors the signed cookie form
 * (`better-auth.session_token=<token>.<signature>`) and the CLI cannot
 * produce that signature without the auth secret. With `bearer()`
 * loaded (see `apps/api/src/modules/oidc/auth/plugins.ts`), BA looks up
 * the session by token and promotes it to the request context exactly
 * as it would for a cookie — all downstream guards (realm,
 * X-Org-Id membership, etc.) behave identically to a browser session.
 *
 * Inject `X-Org-Id` when the profile is pinned to a specific
 * organization — matches the dashboard SPA's header contract
 * (`apps/web/src/lib/api.ts`) so routes that use `requireOrgMembership`
 * work identically from the CLI.
 *
 * There is NO automatic refresh flow: BA's `deviceAuthorization()`
 * plugin does not mint refresh tokens (see
 * `docs/specs/cli-preflight-results.md` § Residual caveats). On 401 we
 * surface a clean `re-login required` error so the calling command can
 * render instructions rather than silently fail.
 */

import { loadTokens } from "./keyring.ts";
import { getProfile, type Profile } from "./config.ts";
import { CLI_USER_AGENT } from "./version.ts";

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

function normalizeBase(instance: string): string {
  return instance.endsWith("/") ? instance.slice(0, -1) : instance;
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

async function resolveTokensOrThrow(profileName: string): Promise<string> {
  const tokens = await loadTokens(profileName);
  if (!tokens) {
    throw new AuthError(
      `No credentials for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
    );
  }
  if (tokens.expiresAt <= Date.now()) {
    throw new AuthError(
      `Session expired for profile "${profileName}". Run: appstrate login --profile ${profileName}`,
    );
  }
  return tokens.accessToken;
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
 */
export async function apiFetchRaw(
  profileName: string,
  path: string,
  init: ApiFetchInit = {},
): Promise<Response> {
  const profile = await resolveProfileOrThrow(profileName);
  const token = await resolveTokensOrThrow(profileName);

  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    Authorization: `Bearer ${token}`,
    "User-Agent": CLI_USER_AGENT,
  };
  if (!headers["Content-Type"] && init.body) {
    headers["Content-Type"] = "application/json";
  }
  if (profile.orgId) headers["X-Org-Id"] = profile.orgId;

  return fetch(`${normalizeBase(profile.instance)}${path}`, { ...init, headers });
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
