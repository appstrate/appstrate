// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 7591 OAuth 2.0 Dynamic Client Registration — the MCP-spec auto-DCR
 * primitive.
 *
 * MCP authorization servers (e.g. `mcp.clickup.com`) expose a
 * `registration_endpoint` and let a client register itself programmatically
 * instead of an operator hand-creating an OAuth app. This module performs that
 * registration POST and returns the issued `client_id` (+ optional secret /
 * RFC 7592 management credentials).
 *
 * PURE — network I/O only, no DB. The orchestrator (apps/api) supplies the
 * endpoint (resolved via discovery) and persists the result in
 * `integration_oauth_clients`. The endpoint is attacker-influenced (it comes
 * from the AS discovery metadata of an org-configured remote MCP server), so
 * the default transport is the SSRF-guarded {@link guardedFetch} — same
 * posture as `mcp-oauth-discovery.ts` — never raw global `fetch`.
 */

import { guardedFetch } from "@appstrate/core/ssrf";
import type { TokenEndpointAuthMethod } from "./types.ts";

export interface RegisterDynamicClientInput {
  /** RFC 7591 §3 registration endpoint (from AS metadata discovery). */
  registrationEndpoint: string;
  /** Redirect URI to register — MUST equal the callback the connect flow uses. */
  redirectUri: string;
  /** Human-readable client name (RFC 7591 `client_name`). */
  clientName: string;
  /** Requested scopes (RFC 7591 `scope`, space-joined). Optional. */
  scopes?: string[];
  /**
   * Token-endpoint client-auth method to request. Defaults to `"none"` (public
   * client + PKCE — the MCP-spec norm). Pass a confidential method only when the
   * AS requires a client secret.
   */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  /**
   * Grant types to register (RFC 7591 `grant_types`). Defaults to
   * `["authorization_code"]`. Pass `["authorization_code","refresh_token"]` to
   * obtain refresh-token capability — but only when the AS advertises the
   * `refresh_token` grant (RFC 8414 `grant_types_supported`): a server that
   * doesn't support it may reject a registration that requests it. Registering
   * for authorization_code alone is why an AS never issues a refresh token
   * (Claude Code #7744), so the connection can't self-renew.
   */
  grantTypes?: string[];
  /**
   * Testing seam — defaults to the SSRF-guarded {@link guardedFetch} (per-hop
   * DNS + blocklist, manual redirects, non-http(s) rejection) with
   * `maxRedirects: 0`. The registration endpoint comes from
   * attacker-influencable discovery metadata, so the default MUST be guarded —
   * never raw global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

export interface DynamicClientRegistration {
  clientId: string;
  /** Present only when the AS issues a confidential client. */
  clientSecret?: string;
  /** RFC 7592 management credentials (when the AS supports client management). */
  registrationAccessToken?: string;
  registrationClientUri?: string;
}

/** Raised when dynamic registration fails (non-2xx, malformed body, network). */
export class DynamicClientRegistrationError extends Error {
  readonly status?: number;
  /**
   * RFC 6749 §5.2 / RFC 7591 §3.2.2 `error_description`, when the AS returned a
   * JSON error body — the human-readable reason registration was rejected (e.g.
   * an allowlist notice). The actionable part to surface to the operator.
   */
  readonly errorDescription?: string;
  constructor(message: string, status?: number, errorDescription?: string) {
    super(message);
    this.name = "DynamicClientRegistrationError";
    this.status = status;
    this.errorDescription = errorDescription;
  }
}

/**
 * Best-effort extraction of the RFC 6749/7591 `error_description` from a
 * registration error body. Returns `undefined` when the body isn't a JSON error
 * object — the caller keeps the raw status/text.
 */
function parseOAuthErrorDescription(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { error_description?: unknown };
    return typeof json.error_description === "string" ? json.error_description : undefined;
  } catch {
    return undefined;
  }
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Default transport: {@link guardedFetch} with `maxRedirects: 0`. DCR is a
 * one-shot POST to a discovered endpoint — a 3xx answer is either a
 * misconfigured AS or an attempt to bounce the registration elsewhere, so no
 * redirect is ever followed (the guard fails closed with `too-many-redirects`).
 */
const guardedDcrFetch = ((input: string | URL, init?: RequestInit) =>
  guardedFetch(input, init, { maxRedirects: 0 })) as unknown as typeof fetch;

interface RawRegistrationResponse {
  client_id?: unknown;
  client_secret?: unknown;
  registration_access_token?: unknown;
  registration_client_uri?: unknown;
}

/**
 * Register a client with an RFC 7591 authorization server. Throws
 * {@link DynamicClientRegistrationError} on any failure so the caller can fall
 * back to the "operator must register an OAuth client" path.
 */
export async function registerDynamicClient(
  input: RegisterDynamicClientInput,
): Promise<DynamicClientRegistration> {
  const fetchImpl = input.fetchImpl ?? guardedDcrFetch;
  const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? "none";

  const body: Record<string, unknown> = {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    grant_types: input.grantTypes ?? ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    ...(input.scopes && input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
  };

  let res: Response;
  try {
    res = await fetchImpl(input.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DynamicClientRegistrationError(
      `Dynamic client registration request failed: ${String(err)}`,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore — status is enough.
    }
    throw new DynamicClientRegistrationError(
      `Dynamic client registration returned ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      parseOAuthErrorDescription(detail),
    );
  }

  let json: RawRegistrationResponse;
  try {
    json = (await res.json()) as RawRegistrationResponse;
  } catch (err) {
    throw new DynamicClientRegistrationError(
      `Dynamic client registration response was not JSON: ${String(err)}`,
      res.status,
    );
  }

  if (typeof json.client_id !== "string" || json.client_id.length === 0) {
    throw new DynamicClientRegistrationError(
      "Dynamic client registration response missing client_id",
      res.status,
    );
  }

  return {
    clientId: json.client_id,
    ...(typeof json.client_secret === "string" && json.client_secret.length > 0
      ? { clientSecret: json.client_secret }
      : {}),
    ...(typeof json.registration_access_token === "string"
      ? { registrationAccessToken: json.registration_access_token }
      : {}),
    ...(typeof json.registration_client_uri === "string"
      ? { registrationClientUri: json.registration_client_uri }
      : {}),
  };
}
