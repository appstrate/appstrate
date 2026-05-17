// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2b — OAuth 2.1 auth wrapper for the MCP HTTP transport
 * (proposal §4.1.1 `serverAuth`, MCP spec 2025-11-25 §6).
 *
 * When an integration declares `serverAuth.type === "oauth2-mcp"`, the
 * runtime must authenticate every request to the MCP server's HTTP
 * endpoint. Three flows live in this module:
 *
 *   1. {@link parseWwwAuthenticateChallenge} — pulls the
 *      `resource_metadata=` (RFC 9728 bootstrap) and `scope=` (step-up)
 *      values out of a `WWW-Authenticate: Bearer` header.
 *
 *   2. {@link executeWithBearer} — wraps a `fetch`-like call, attaching
 *      the current bearer token. On 401, parses the challenge and, when
 *      a scope step-up is requested, calls the consumer-supplied
 *      `acquireToken` to obtain a token with the wider scope, then
 *      retries ONCE. Capped to avoid auth loops.
 *
 *   3. {@link buildAuthorizationUrl} — builds an authorize URL with
 *      `resource=` (RFC 8707 mandatory per MCP spec) + `code_challenge`
 *      (PKCE S256 mandatory) + scopes.
 *
 * Pure + injectable. The actual `fetch` is taken from the caller so
 * tests can route every request through an in-memory mock and assert
 * the retry policy without standing up a fake AS.
 */

// ─────────────────────────────────────────────
// WWW-Authenticate parsing
// ─────────────────────────────────────────────

export interface WwwAuthenticateChallenge {
  scheme: string; // typically "Bearer"
  realm?: string;
  error?: string;
  error_description?: string;
  /** RFC 9728 bootstrap — points at the protected-resource metadata document. */
  resource_metadata?: string;
  /** Step-up — scope the AS wants the next token to carry. */
  scope?: string;
  /** Verbatim params for callers that need fields beyond the standard set. */
  params: Record<string, string>;
}

/**
 * Parse a `WWW-Authenticate` header into a structured challenge.
 * Returns `null` when the header is absent or the scheme isn't Bearer
 * — caller should treat that as "no actionable challenge".
 *
 * The parser is intentionally permissive on whitespace and quoting,
 * matching RFC 6750 §3 grammar. It does NOT handle multiple comma-
 * separated challenges (e.g. `Bearer realm="x", Basic realm="y"`) —
 * Bearer-first wins, the rest is ignored.
 */
export function parseWwwAuthenticateChallenge(
  header: string | null | undefined,
): WwwAuthenticateChallenge | null {
  if (!header || typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // Bearer-prefix tolerant matcher.
  const bearerIdx = trimmed.toLowerCase().indexOf("bearer");
  if (bearerIdx < 0) return null;
  const tail = trimmed.slice(bearerIdx + "bearer".length).trimStart();

  const params: Record<string, string> = {};
  // Split on commas not inside quotes.
  const segments = splitParams(tail);
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let value = seg.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    if (key.length > 0) params[key] = value;
  }

  const out: WwwAuthenticateChallenge = { scheme: "Bearer", params };
  if (params.realm !== undefined) out.realm = params.realm;
  if (params.error !== undefined) out.error = params.error;
  if (params.error_description !== undefined) out.error_description = params.error_description;
  if (params.resource_metadata !== undefined) out.resource_metadata = params.resource_metadata;
  if (params.scope !== undefined) out.scope = params.scope;
  return out;
}

function splitParams(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

// ─────────────────────────────────────────────
// Token-bearing fetch with step-up retry
// ─────────────────────────────────────────────

export interface BearerCredential {
  /** Access token to send as `Authorization: Bearer <token>`. */
  accessToken: string;
  /** Scopes the current token was granted. */
  scopes?: readonly string[];
  /** Epoch ms when the token expires (informational — runtime can pre-refresh). */
  expiresAt?: number;
}

export interface ExecuteWithBearerOptions {
  /** Initial bearer to attach. The wrapper trusts the caller to pre-refresh. */
  initial: BearerCredential;
  /**
   * Called once on a 401 that includes a `scope=` step-up challenge or
   * an `insufficient_scope` error. Receives the requested scopes; must
   * return a fresh credential. Throwing aborts the request with the
   * underlying error wrapped in {@link StepUpFailedError}.
   */
  acquireToken?: (requested: {
    scopes: string[];
    challenge: WwwAuthenticateChallenge;
  }) => Promise<BearerCredential>;
  /** Number of step-up retries allowed (default 1). */
  maxRetries?: number;
}

export interface ExecuteWithBearerResult {
  response: Response;
  /** Bearer used on the **final** request (after any step-up). */
  bearerUsed: BearerCredential;
  /** Number of HTTP calls actually made (1 = no step-up, 2 = one retry). */
  attemptCount: number;
}

export class StepUpFailedError extends Error {
  override readonly name = "StepUpFailedError";
  readonly underlying: unknown;
  constructor(underlying: unknown) {
    super("Step-up token acquisition failed");
    this.underlying = underlying;
  }
}

export class AuthLoopExceededError extends Error {
  override readonly name = "AuthLoopExceededError";
}

/**
 * Make an HTTP call attaching the current bearer. On 401 with
 * `insufficient_scope` (or any 401 carrying `scope=` in the
 * challenge), invoke `acquireToken` to fetch a token with the
 * widened scope and retry — up to `maxRetries` times (default 1).
 *
 * Plain 401 with no scope hint is returned to the caller unchanged
 * so the consumer can surface a re-auth UI instead of looping.
 */
export async function executeWithBearer(
  doFetch: (init: { headers: Record<string, string> }) => Promise<Response>,
  options: ExecuteWithBearerOptions,
): Promise<ExecuteWithBearerResult> {
  const maxRetries = options.maxRetries ?? 1;
  let bearer = options.initial;
  let attemptCount = 0;
  let response: Response;

  while (true) {
    attemptCount += 1;
    if (attemptCount > maxRetries + 1) {
      throw new AuthLoopExceededError();
    }
    response = await doFetch({
      headers: { Authorization: `Bearer ${bearer.accessToken}` },
    });
    if (response.status !== 401) {
      return { response, bearerUsed: bearer, attemptCount };
    }
    const challenge = parseWwwAuthenticateChallenge(response.headers.get("WWW-Authenticate"));
    const stepUp =
      challenge &&
      (challenge.error === "insufficient_scope" ||
        (challenge.scope !== undefined && challenge.scope.trim().length > 0));
    if (!stepUp || !options.acquireToken) {
      // Plain 401 — return to caller without looping.
      return { response, bearerUsed: bearer, attemptCount };
    }
    if (attemptCount > maxRetries) {
      throw new AuthLoopExceededError();
    }
    const requestedScopes = (challenge.scope ?? "").split(/\s+/).filter(Boolean);
    try {
      bearer = await options.acquireToken({ scopes: requestedScopes, challenge });
    } catch (err) {
      throw new StepUpFailedError(err);
    }
  }
}

// ─────────────────────────────────────────────
// Authorize URL builder
// ─────────────────────────────────────────────

export interface BuildAuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** RFC 8707 — MANDATORY for MCP per 2025-11-25 spec. */
  resource: string;
  /** Optional space-delimited scopes. */
  scopes?: readonly string[];
  /** PKCE S256 challenge (base64url of SHA256(verifier)). */
  codeChallenge: string;
  /** Opaque caller state — round-tripped to the redirect URI. */
  state: string;
}

/**
 * Build the authorize URL for an OAuth 2.1 PKCE flow targeting the MCP
 * HTTP transport. Always emits `response_type=code` (Authorization Code
 * is the only flow MCP allows), `code_challenge_method=S256`, and
 * `resource=` (RFC 8707 — MCP requires it even when the AS does not
 * yet support audience binding; per the proposal §4.1.1 this is the
 * spec-compliant behaviour, and unsupported ASs ignore it silently).
 */
export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scopes && input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(" "));
  }
  return url.toString();
}
