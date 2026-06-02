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
 * endpoint (resolved via discovery), persists the result in
 * `integration_oauth_clients`, and is responsible for SSRF-guarding the
 * endpoint before calling here (same posture as the userinfo fetch).
 */

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
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  /** Testing seam — defaults to global `fetch`. */
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
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DynamicClientRegistrationError";
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 10_000;

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
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? "none";

  const body: Record<string, unknown> = {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code"],
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
