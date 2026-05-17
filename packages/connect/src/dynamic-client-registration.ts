// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2b — RFC 7591 Dynamic Client Registration.
 *
 * Required by the MCP HTTP transport spec (2025-11-25): when an MCP
 * server protects its `streamable-http`/`sse` endpoint with OAuth 2.1
 * and no `client_id` is pre-shared, the runtime must register on the
 * fly via the AS's `registration_endpoint`. This module implements the
 * minimum subset:
 *
 *   - POST `application/json` body with `redirect_uris[]` and the
 *     standard metadata fields (`client_name`, `token_endpoint_auth_method`,
 *     `grant_types`, `response_types`).
 *   - Read the AS response, validate `client_id` exists, surface
 *     `client_secret`/`client_id_issued_at`/`registration_access_token`
 *     verbatim for storage.
 *   - SSRF protection on the registration endpoint URL — same primitive
 *     as `oauth-discovery.ts`.
 *
 * Pure + injectable: the network call is a {@link FetchJsonFn}, the
 * clock is a {@link ClockFn}. No DB, no persistence — the caller owns
 * storage policy (per-integration, per-tenant, etc.).
 *
 * What we deliberately DON'T implement:
 *
 *   - Software statements (RFC 7591 §2.3) — we don't yet ship a JWT
 *     issuer for the runtime; can be layered above this module later.
 *   - Token endpoint auth other than `none` and `client_secret_post`
 *     — Phase 1.2b only needs PKCE + `none` (public client) or the
 *     `client_secret_post` fallback for confidential clients.
 *   - Per-AS overrides on `software_id` / `software_version` — defaulted
 *     to the runtime's identity.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

export type DcrErrorCode =
  | "BLOCKED_URL"
  | "INVALID_REGISTRATION_URL"
  | "REGISTRATION_FAILED"
  | "INVALID_RESPONSE"
  | "MISSING_CLIENT_ID";

export class DcrError extends Error {
  override readonly name = "DcrError";
  readonly code: DcrErrorCode;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: DcrErrorCode,
    message: string,
    extras: { httpStatus?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.code = code;
    if (extras.httpStatus !== undefined) this.httpStatus = extras.httpStatus;
    if (extras.details !== undefined) this.details = extras.details;
  }
}

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/** Client metadata sent in the registration POST (RFC 7591 §2). */
export interface ClientRegistrationRequest {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  software_id?: string;
  software_version?: string;
  /** Free-form extension — caller can add `tos_uri`, `policy_uri`, etc. */
  [key: string]: unknown;
}

/** Successful registration response (RFC 7591 §3.2.1). */
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
  /** Echo of every field the AS chose to confirm (RFC 7591 §3.2.1). */
  [key: string]: unknown;
}

/** Injectable POST helper — `fetch` by default. Tests pass a stub. */
export type DcrFetchFn = (url: string, body: string) => Promise<{ status: number; body: unknown }>;

export interface RegisterClientOptions {
  registrationEndpoint: string;
  request: ClientRegistrationRequest;
  /** Override the injected fetcher (testing). */
  fetch?: DcrFetchFn;
}

// ─────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SOFTWARE_ID = "appstrate-runtime";

/**
 * Run a Dynamic Client Registration against the AS's
 * `registration_endpoint`. Returns the response verbatim — caller is
 * responsible for persisting it (and the `registration_access_token`
 * which is the only key that can later update / delete the client).
 *
 * Throws {@link DcrError} on every failure path so the caller can map
 * the structured `code` to a UI message.
 */
export async function registerClient(
  options: RegisterClientOptions,
): Promise<ClientRegistrationResponse> {
  const url = options.registrationEndpoint;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DcrError(
      "INVALID_REGISTRATION_URL",
      `registration_endpoint is not a valid URL: ${url}`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new DcrError(
      "INVALID_REGISTRATION_URL",
      `registration_endpoint must be https (got ${parsed.protocol})`,
    );
  }
  if (isBlockedUrl(url)) {
    throw new DcrError("BLOCKED_URL", `registration_endpoint is SSRF-blocked: ${url}`);
  }

  const body = JSON.stringify({
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    software_id: DEFAULT_SOFTWARE_ID,
    ...options.request,
  });

  const doFetch = options.fetch ?? defaultDcrFetch;
  const response = await doFetch(url, body);

  if (response.status < 200 || response.status >= 300) {
    throw new DcrError("REGISTRATION_FAILED", `registration failed with HTTP ${response.status}`, {
      httpStatus: response.status,
      details: { body: response.body },
    });
  }

  if (!response.body || typeof response.body !== "object") {
    throw new DcrError("INVALID_RESPONSE", "registration response was not a JSON object");
  }
  const reg = response.body as Record<string, unknown>;
  if (typeof reg.client_id !== "string" || reg.client_id.length === 0) {
    throw new DcrError("MISSING_CLIENT_ID", "registration response is missing client_id", {
      details: reg,
    });
  }

  return reg as ClientRegistrationResponse;
}

// ─────────────────────────────────────────────
// Default fetcher
// ─────────────────────────────────────────────

const defaultDcrFetch: DcrFetchFn = async (url, body) => {
  const controller = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    signal: controller,
  });
  let parsed: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave parsed=null — `registerClient` will surface
      // INVALID_RESPONSE because parsed isn't an object.
    }
  }
  return { status: response.status, body: parsed };
};
