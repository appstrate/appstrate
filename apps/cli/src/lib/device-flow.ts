// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8628 Device Authorization Grant — client side.
 *
 * Plain `fetch()` against BA-mounted endpoints:
 *   - `/api/auth/device/code` to initiate (RFC 8628 §3.1).
 *   - `/api/auth/cli/token`   to poll / exchange (Appstrate #165).
 *
 * **Token shape change (issue #165)**: since v2.x we poll
 * `/api/auth/cli/token` (NOT `/api/auth/device/token`) and receive a
 * **signed JWT access token (15 min) + rotating opaque refresh token
 * (30 d)** instead of a 7-day Better Auth session. The same endpoint
 * also serves the silent-refresh grant (`grant_type=refresh_token`) so
 * the CLI can mint fresh access tokens without re-authenticating. The
 * protocol stays RFC 8628 — only the response shape widens with a
 * `refresh_token` field and the transport endpoint moves to a different
 * path. Legacy 1.x CLI binaries continue to work against the original
 * `/device/token` endpoint which the server keeps mounted for backward
 * compatibility.
 *
 * Two entry points:
 *   - `startDeviceFlow(instance, clientId, scope)` → initial pair of
 *     codes + polling parameters.
 *   - `pollDeviceFlow(instance, deviceCode, clientId, { interval, signal })`
 *     → blocks until the user approves (access_token) or the grant
 *     terminates (`expired_token` / `access_denied`). Honors the
 *     `slow_down` backoff RFC 8628 §3.5 prescribes.
 */

import { setTimeout as delay } from "node:timers/promises";
import { assertSafeVerificationUrl, normalizeInstance } from "./instance-url.ts";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds until the device_code expires. */
  expiresIn: number;
  /** Minimum seconds between `/cli/token` polls. */
  interval: number;
}

export interface DeviceTokenResponse {
  accessToken: string;
  /**
   * 30-day rotating refresh token issued by `/api/auth/cli/token`
   * alongside the JWT access. `undefined` only on servers that still
   * host the legacy `/device/token` handler — the CLI treats a
   * missing refresh_token as an auth-protocol downgrade and surfaces
   * it through `commands/login.ts`.
   */
  refreshToken?: string;
  tokenType: string;
  /** Seconds until the access_token expires. */
  expiresIn: number;
  /** Seconds until the refresh_token expires. 0 when none issued. */
  refreshExpiresIn?: number;
  scope: string;
}

/**
 * Structured error raised by `startDeviceFlow` / `pollDeviceFlow` when
 * the server returns an RFC 8628 error. Terminal codes are:
 *   - `access_denied`: user clicked "Refuser" or a realm mismatch
 *     fired on `/device/approve`.
 *   - `expired_token`: the user didn't approve before `expires_in`.
 *   - `invalid_client` / `invalid_grant` / `invalid_request`: protocol
 *     misuse (wrong client_id, wrong device_code, malformed request).
 *
 * `authorization_pending` and `slow_down` are transient and handled by
 * `pollDeviceFlow` without bubbling up.
 */
export class DeviceFlowError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string | undefined,
    public readonly httpStatus: number,
  ) {
    super(description ?? code);
    this.name = "DeviceFlowError";
  }
}

interface RawErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * RFC 8628 §3.2 — initiate the grant.
 *
 * Body is `application/x-www-form-urlencoded` per the spec. The Appstrate
 * server accepts both form-urlencoded and JSON at these endpoints (a
 * platform-level shim transforms form-urlencoded → JSON before Better
 * Auth's `better-call` router sees the request). Sticking to the RFC
 * content type here keeps the CLI interoperable with any standards-
 * compliant OIDC server as well.
 */
export async function startDeviceFlow(
  instance: string,
  clientId: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const normalizedInstance = normalizeInstance(instance);
  const body = new URLSearchParams({ client_id: clientId, scope });
  const res = await fetch(`${normalizedInstance}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await parseErrorBody(res);
    throw new DeviceFlowError(err.error ?? "invalid_request", err.error_description, res.status);
  }
  const json = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
  // Validate both verification URLs before returning. A malicious or
  // compromised server could attempt to redirect the user's browser to
  // `file:///etc/passwd`, `javascript:…`, or an attacker-controlled
  // domain — `assertSafeVerificationUrl` rejects non-http(s) schemes and
  // enforces host-match against the instance the CLI was invoked with.
  // Failures throw `DeviceFlowError` so `commands/login.ts` renders them
  // through the same terminal-error path as any other protocol failure.
  try {
    assertSafeVerificationUrl(json.verification_uri, normalizedInstance);
    assertSafeVerificationUrl(json.verification_uri_complete, normalizedInstance);
  } catch (err) {
    throw new DeviceFlowError(
      "invalid_request",
      err instanceof Error ? err.message : String(err),
      res.status,
    );
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: json.verification_uri_complete,
    expiresIn: json.expires_in,
    interval: json.interval,
  };
}

export interface PollOptions {
  /** Starting poll interval in seconds. Bumped on `slow_down`. */
  interval: number;
  /** Total wait budget in seconds — usually the `expires_in` from the code response. */
  expiresIn: number;
  /** Abort the polling loop early. */
  signal?: AbortSignal;
  /** Injectable delay for tests — defaults to `setTimeout`. Do not set in prod. */
  delayFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Injectable clock for tests — defaults to `Date.now`. Scoped to this
   * poll loop only; the test no longer has to monkey-patch the global
   * `Date.now`, which would otherwise leak into any parallel code in
   * the same Bun worker and make the suite order-dependent. Do not set
   * in prod.
   */
  now?: () => number;
}

/**
 * Hard ceiling on the total polling duration, independent of the
 * `expires_in` the server returns in `/device/code`. A compromised or
 * misbehaving server could return `expires_in: 86400` and trap the CLI
 * in a 24-hour loop shipping tokens (or nothing) to whoever replies;
 * this cap is the belt-and-braces limit on top of the server's own
 * deadline. 15 minutes leaves comfortable headroom over the BA plugin's
 * 10-minute default for legitimate slow approvals (user away from
 * browser for a minute, looking up password, etc.). On reach, the loop
 * exits with `expired_token` — same terminal state the legit path hits.
 */
const MAX_POLL_DURATION_MS = 15 * 60 * 1000;

/** RFC 8628 §3.4 — poll the token endpoint until terminal response or budget exhausted. */
export async function pollDeviceFlow(
  instance: string,
  deviceCode: string,
  clientId: string,
  opts: PollOptions,
): Promise<DeviceTokenResponse> {
  // Use the MIN of the server-suggested `expires_in` and our own hard
  // ceiling so neither side can push the loop past what the other
  // considers safe. Tests can still race through with `expiresIn: 0`
  // because Math.min picks that value.
  const clock = opts.now ?? Date.now;
  const now = clock();
  const deadline = Math.min(now + opts.expiresIn * 1000, now + MAX_POLL_DURATION_MS);
  // Tests pass `interval: 0` + a no-op `delayFn` to race through the
  // loop; production code would never set either to 0. The `Math.max(0, …)`
  // guard exists only so a pathological `interval: -1` from a misbehaving
  // server doesn't deadlock the loop.
  let interval = Math.max(0, opts.interval);
  const delayFn =
    opts.delayFn ??
    ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }).then(() => undefined));

  // Form-urlencoded body per RFC 8628 §3.4. Server accepts both content
  // types; we stick to the RFC so the CLI interoperates with any
  // standards-compliant OIDC provider.
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: clientId,
  }).toString();

  while (clock() < deadline) {
    if (opts.signal?.aborted) {
      throw new DeviceFlowError("access_denied", "Polling aborted by caller.", 0);
    }
    try {
      await delayFn(interval * 1000, opts.signal);
    } catch {
      // AbortError from the delay — surface as access_denied so the
      // `login` command renders a consistent terminal state.
      throw new DeviceFlowError("access_denied", "Polling aborted by caller.", 0);
    }

    // NOTE: `/api/auth/cli/token` replaces `/api/auth/device/token` for
    // the 2.x CLI (issue #165). The new endpoint returns JWT + rotating
    // refresh pair; the original stays mounted server-side for 1.x
    // binaries but we never poll it from this branch.
    const res = await fetch(`${normalizeInstance(instance)}/api/auth/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (res.ok) {
      const json = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        token_type: string;
        expires_in: number;
        refresh_expires_in?: number;
        scope: string;
      };
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        tokenType: json.token_type,
        expiresIn: json.expires_in,
        refreshExpiresIn: json.refresh_expires_in,
        scope: json.scope ?? "",
      };
    }

    const err = await parseErrorBody(res);
    const code = err.error ?? "invalid_request";
    if (code === "authorization_pending") {
      // Keep the current interval.
      continue;
    }
    if (code === "slow_down") {
      // RFC 8628 §3.5 — bump by at least 5 seconds. BA's plugin already
      // enforces the minimum server-side, so a fixed +5s bump here is
      // friendly to both sides.
      interval += 5;
      continue;
    }
    // Any other code is terminal.
    throw new DeviceFlowError(code, err.error_description, res.status);
  }

  throw new DeviceFlowError(
    "expired_token",
    "The device code expired before the user approved it.",
    0,
  );
}

/**
 * `grant_type=refresh_token` — exchange the stored refresh token for a
 * fresh access + refresh pair (rotation). Issue #165. Returns the new
 * pair; the caller must persist it atomically (the old refresh token is
 * single-use — a second exchange of the same plaintext triggers the
 * server-side reuse-detection sweep that revokes the whole family).
 *
 * On any non-2xx response, throws `DeviceFlowError(code, description,
 * status)` — callers distinguish recoverable from terminal states:
 *   - `invalid_grant`: refresh token expired, revoked, or already
 *     rotated (replay). The CLI must clear local credentials and
 *     prompt `appstrate login`.
 *   - transient HTTP errors (network, 5xx): surfaced so the caller can
 *     decide to retry or fall through to re-auth.
 */
export async function refreshCliTokens(
  instance: string,
  clientId: string,
  refreshToken: string,
): Promise<DeviceTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();
  const res = await fetch(`${normalizeInstance(instance)}/api/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const err = await parseErrorBody(res);
    throw new DeviceFlowError(err.error ?? "invalid_request", err.error_description, res.status);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    refresh_expires_in?: number;
    scope: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type,
    expiresIn: json.expires_in,
    refreshExpiresIn: json.refresh_expires_in,
    scope: json.scope ?? "",
  };
}

/**
 * Server-side revocation of a refresh-token family. Called on
 * `appstrate logout` before local credential cleanup.
 *
 * Contract: throws `DeviceFlowError` on any non-2xx response (network
 * error, 4xx, 5xx). Callers that want best-effort revocation (e.g.
 * `logout.ts`) MUST wrap the call in try/catch and proceed with local
 * cleanup on failure — revocation state is advisory from the client's
 * perspective, but surfacing the error at the call site lets the
 * command render a clear warning rather than silently skipping it.
 *
 * The 200 body (`{ revoked: boolean }`) is intentionally ignored —
 * `revoked: false` just means the token was unknown or client-mismatched
 * on the server, which is operationally equivalent to success from the
 * CLI's perspective (the token is dead to us either way).
 */
export async function revokeCliRefreshToken(
  instance: string,
  clientId: string,
  refreshToken: string,
): Promise<void> {
  const body = new URLSearchParams({
    token: refreshToken,
    client_id: clientId,
  }).toString();
  const res = await fetch(`${normalizeInstance(instance)}/api/auth/cli/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const err = await parseErrorBody(res);
    throw new DeviceFlowError(err.error ?? "invalid_request", err.error_description, res.status);
  }
}

async function parseErrorBody(res: Response): Promise<RawErrorBody> {
  try {
    const parsed = (await res.json()) as RawErrorBody;
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}
