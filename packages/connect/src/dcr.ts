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
  /**
   * `token_endpoint_auth_method` **as the authorization server registered it**
   * — its answer, not the request's echo. RFC 7591 §3.2.1 explicitly allows an
   * AS to "replace any invalid values with suitable default values", and to
   * state the substitution in the response, so a `"none"` request can come back
   * registered as `client_secret_basic`. Discarding this field is how a
   * confidential registration used to be stored as a public client and only
   * detonate at the OAuth callback, after the user had already consented.
   *
   * Deliberately a raw `string`, not {@link TokenEndpointAuthMethod}: narrowing
   * here would map exactly the answers a caller must react to (an unsupported
   * or contradictory method) onto `undefined`, i.e. back onto "the AS said
   * nothing" — the inference this field exists to remove. Absent only when the
   * AS genuinely omitted it.
   */
  tokenEndpointAuthMethod?: string;
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
  /**
   * RFC 6749 §5.2 / RFC 7591 §3.2.2 `error` — the short registry token naming
   * the failure CLASS (`invalid_redirect_uri`, `invalid_client_metadata`, …).
   * The description is optional in both RFCs, so an AS may answer with the code
   * alone; when it does, this is the only thing separating "the redirect URI
   * you registered is not the one you use" — a one-minute fix — from an opaque
   * refusal. Machine-readable and credential-free by construction, unlike the
   * free-text description.
   */
  readonly errorCode?: string;
  constructor(message: string, status?: number, errorDescription?: string, errorCode?: string) {
    super(message);
    this.name = "DynamicClientRegistrationError";
    this.status = status;
    this.errorDescription = errorDescription;
    this.errorCode = errorCode;
  }
}

/**
 * Best-effort extraction of the RFC 6749/7591 error members from a registration
 * error body. BOTH halves are read, because they fail independently: the
 * `error_description` is the human-readable reason (an allowlist notice, a
 * malformed-metadata hint) and is optional, while the `error` code names the
 * failure class in the protocol's own vocabulary. A server answering
 * `{"error":"invalid_redirect_uri"}` with no description carries all of its
 * diagnosis in the code, so reading only the description turns that answer into
 * a generic line plus a bare HTTP status. Returns an empty object when the body
 * isn't a JSON error object — the caller keeps the raw status/text.
 */
function parseOAuthErrorBody(body: string): { error?: string; errorDescription?: string } {
  try {
    const json = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    return {
      ...(typeof json.error === "string" ? { error: json.error } : {}),
      ...(typeof json.error_description === "string"
        ? { errorDescription: json.error_description }
        : {}),
    };
  } catch {
    return {};
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
  /** RFC 7591 §3.2.1 — the method the AS registered, which may not be the one asked for. */
  token_endpoint_auth_method?: unknown;
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
    const oauthError = parseOAuthErrorBody(detail);
    throw new DynamicClientRegistrationError(
      `Dynamic client registration returned ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      oauthError.errorDescription,
      oauthError.error,
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
    ...(typeof json.token_endpoint_auth_method === "string" &&
    json.token_endpoint_auth_method.length > 0
      ? { tokenEndpointAuthMethod: json.token_endpoint_auth_method }
      : {}),
    ...(typeof json.registration_access_token === "string"
      ? { registrationAccessToken: json.registration_access_token }
      : {}),
    ...(typeof json.registration_client_uri === "string"
      ? { registrationClientUri: json.registration_client_uri }
      : {}),
  };
}
