// SPDX-License-Identifier: Apache-2.0

/**
 * Credential proxy endpoint (BYOI for external runners).
 *
 * Wire-compatible with the runtime-pi sidecar `/proxy` contract. Accepts
 * bearer auth: API keys (headless / GitHub Action) or OIDC-issued JWTs
 * (interactive CLI device-flow, dashboard second-party apps). Cookie
 * sessions are rejected.
 *
 * The handler is registered as `router.all("/proxy", …)` because upstream
 * provider semantics are method-defined (Gmail, ClickUp, etc. all rely on
 * GET/POST/PUT/PATCH/DELETE). A POST-only route would silently 404 every
 * non-POST tool call, which agents paraphrase as "the API is unavailable".
 * Each accepted verb is documented below with the same operation shape.
 */

const proxySharedDescription =
  "High-value endpoint. Accepts an upstream HTTP request and forwards it to the " +
  "upstream API after injecting the stored credentials server-side. Credentials never " +
  "leave Appstrate.\n\n" +
  "Authentication: bearer only — either an API key with the `credential-proxy:call` " +
  "scope (NOT granted by default) or an OIDC-issued JWT (device-flow access token " +
  "for the interactive CLI, dashboard access token for second-party apps). Cookie " +
  "sessions are rejected. Session binding pins the `X-Session-Id` to the first " +
  "principal (API key or JWT user) that used it.\n\n" +
  "Optional `Appstrate-User` header scopes the call to an end-user's connection " +
  "(API-key auth only).\n\n" +
  "URL and headers can contain `{{credential_field}}` placeholders substituted " +
  "against the integration's credential schema. Set `X-Substitute-Body: 1` to run " +
  "the same substitution on the request body (verbs that carry one).\n\n" +
  "Boolean control headers (`X-Substitute-Body`, `X-Stream-Request`, `X-Stream-Response`) " +
  "take `1` or `0`; any other value is a 400.";

const proxyParameters = [
  {
    name: "X-Space-Id",
    in: "header",
    required: true,
    description: "Space id (spc_…) the API key is scoped to.",
    schema: { type: "string" },
  },
  {
    name: "X-Integration-Id",
    in: "header",
    required: true,
    description: "Scoped integration package name (e.g. `@afps/gmail`).",
    schema: { type: "string" },
  },
  {
    name: "X-Target",
    in: "header",
    required: true,
    description:
      "Upstream endpoint: an absolute URL, or one whose `{{credential_field}}` placeholders " +
      "(e.g. `{{site_url}}/wp-json/…`) the platform substitutes from the connection before " +
      "any check; the substituted URL must be absolute. It must match the integration " +
      "manifest auth's `authorized_uris` (rendered for the connection) unless " +
      "`allow_all_uris: true`. `allow_all_uris` is ignored when a " +
      "`{{credential_field}}` placeholder appears in this URL, a header, or a substituted " +
      "body: the target and every redirect hop must then match `authorized_uris`, and the " +
      "call is refused when that list is empty.",
    schema: { type: "string" },
  },
  {
    name: "X-Session-Id",
    in: "header",
    required: true,
    description:
      "Caller-chosen session id; scopes the cookie jar. Fresh UUID per CLI invocation " +
      "is typical.",
    schema: { type: "string" },
  },
  {
    name: "X-Substitute-Body",
    in: "header",
    required: false,
    description:
      "When `1`, the request body is decoded as UTF-8 and `{{field}}` placeholders " +
      "are substituted. Ignored on verbs that do not carry a body (GET, DELETE).",
    schema: { type: "string", enum: ["0", "1"] },
  },
  {
    name: "Appstrate-User",
    in: "header",
    required: false,
    description: "Impersonation header — scopes the call to this end-user's connection.",
    schema: { type: "string", pattern: "^eu_" },
  },
  {
    name: "X-Stream-Request",
    in: "header",
    required: false,
    description:
      "When `1`, forward the request body as a stream instead of buffering. Required for " +
      "uploads larger than the buffered body cap; the upstream content length is still " +
      "validated against `CREDENTIAL_PROXY_LIMITS.max_request_bytes`. Ignored on verbs " +
      "that do not carry a body (GET, DELETE).",
    schema: { type: "string", enum: ["0", "1"] },
  },
  {
    name: "X-Stream-Response",
    in: "header",
    required: false,
    description:
      "When `1`, stream the upstream response body through the 100 MB streaming cap " +
      "instead of buffering it. Skips the buffered `max_response_bytes` truncation, so " +
      "`X-Truncated` is not emitted; an oversized stream is aborted rather than truncated.",
    schema: { type: "string", enum: ["0", "1"] },
  },
  {
    name: "X-Max-Response-Size",
    in: "header",
    required: false,
    description:
      "Optional cap (in bytes) on the buffered upstream response before truncation. " +
      "Clamped to `CREDENTIAL_PROXY_LIMITS.max_response_bytes`. Ignored when " +
      "`X-Stream-Response: 1` is set.",
    schema: { type: "string" },
  },
  {
    name: "X-Run-Id",
    in: "header",
    required: false,
    description:
      "Optional run id (`run_…`) of the run this call acts for — sent by a runner executing it " +
      "(`appstrate run --report`). Must name an in-flight run of the calling actor in this " +
      "space: an unknown id or one of another space is a `404`, another actor's run a `403`, a " +
      "finished run a `400`. It binds the call to the run's snapshot: the call reaches ONLY the " +
      "connections the run's kickoff bound to the integration (every layer applied, agent-level " +
      "ones included — admin pins, enforced defaults, launch overrides, member pins): one bound " +
      "connection is used; several require `X-Connection-Id` naming one of them " +
      "(`409 must_choose_connection` when absent, `400 connection_not_in_run` when it names " +
      "another); none is a `404`, and so is a bound one no longer reachable (deleted or " +
      "unshared); a bound one that needs reconnecting is a " +
      "`409 needs_reconnection`. Without it no agent is in play, so the admin and member pins " +
      "(set per agent) cannot apply — only the space-level rules described under " +
      "`X-Connection-Id` do.",
    schema: { type: "string" },
  },
  {
    name: "X-Connection-Id",
    in: "header",
    required: false,
    description:
      "Optional explicit connection UUID. With `X-Run-Id`, it must name a connection the run " +
      "bound (see `X-Run-Id`). Without it, the space-level rules apply in this order: (1) an " +
      "ENFORCED org default of the integration binds its set — a named id must be a member " +
      "(`400 connection_not_in_org_default` otherwise); (2) the named connection, after " +
      "validating it is one of the caller's own (user or end-user) or a connection another " +
      "member shared in the request's space, of the requested integration; (3) a SOFT org " +
      "default binds its set; (4) the caller's own connections: exactly one is used, none with " +
      "some shared by other members is a `409 must_choose_connection` (a shared connection is " +
      "never used unless named or set as a default), none at all a `404`, several a " +
      "`409 must_choose_connection`. A default set of one is used, several are a " +
      "`409 must_choose_connection` over the set, and a member the caller cannot reach is a " +
      "`409 pinned_connection_unavailable`, and a bound connection whose credentials need " +
      "reconnecting (a default's member included) a `409 needs_reconnection`. A non-uuid " +
      "value is a `400`; mismatched or " +
      "unknown ids surface as `404 — no credentials`.",
    schema: { type: "string", format: "uuid" },
  },
] as const;

const proxyResponses = {
  "200": {
    description:
      "Upstream response (status code, headers, body forwarded verbatim, except " +
      "`Set-Cookie`, which is never relayed: upstream cookies are kept in the server-side " +
      "jar scoped by `X-Session-Id` and replayed on later calls). Buffered " +
      "responses include `X-Truncated` when the body exceeded the platform truncation " +
      "cap; streamed responses (when the upstream sends `Transfer-Encoding: chunked` or " +
      "a `Content-Length` over `max_streamed_body_size`) do not carry this header.",
    headers: {
      "X-Truncated": {
        description:
          "Set to `true` when the buffered upstream body was truncated to " +
          "`CREDENTIAL_PROXY_LIMITS.max_response_bytes`. Absent on streamed responses.",
        schema: { type: "string", enum: ["true"] },
      },
    },
    content: { "*/*": {} },
  },
  "400": {
    description:
      "Missing or malformed control header, a finished `X-Run-Id` run, " +
      "`connection_not_in_run` — `X-Connection-Id` names a connection the `X-Run-Id` run " +
      "did not bind — or `connection_not_in_org_default` — it names a connection outside the " +
      "integration's enforced org default.",
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
  "401": {
    description:
      "Unauthorized. On a streaming-upload 401, the response carries " +
      "`X-Auth-Refreshed: true` when credentials were refreshed server-side but the " +
      "body could not be replayed — the caller must refresh and replay the call itself.",
    headers: {
      "X-Auth-Refreshed": {
        description:
          "Present and set to `true` on a streaming-upload 401 where credentials were " +
          "refreshed but the body could not be replayed. Signals the caller to retry.",
        schema: { type: "string", enum: ["true"] },
      },
    },
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
  "403": {
    description:
      "Forbidden — principal lacks `credential-proxy:call`, target not in " +
      "`authorized_uris`, a credential templated into a call with no allowlist to check it " +
      "against, session bound to a different principal, cookie session used, or `X-Run-Id` " +
      "names another actor's run.",
  },
  "404": {
    description:
      "No credentials or connection for the requested integration — including when no " +
      "connection of it is accessible to the caller, when the `X-Run-Id` run bound none, or " +
      "when `X-Run-Id` names no run of this space.",
  },
  "409": {
    description:
      "`must_choose_connection` — no `X-Connection-Id` and no single candidate: the " +
      "`X-Run-Id` run bound several connections to the integration, or (no run) the org " +
      "default holds several, or the caller owns several or only has other members' shared " +
      "ones. `errors[0].candidate_connections` lists what the caller may name (the run's bound " +
      "set, the default's set, else every own and shared connection), with `label`, " +
      "`account_id`, `owned_by_actor`, `needs_reconnection`; retry with one `id` in " +
      "`X-Connection-Id`. `pinned_connection_unavailable` — (no run) the org default names a " +
      "connection the caller cannot reach (deleted or unshared); an admin must fix the default. " +
      "`needs_reconnection` — the connection that would be bound (the run's bound one included), " +
      "or a member of the org default, needs its owner to reconnect it.",
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
  "413": {
    description: "Request body (streaming upload) exceeds MAX_STREAMED_BODY_SIZE (100 MB).",
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalServerError" },
} as const;

const proxyRequestBody = {
  required: false,
  description:
    "Forwarded as-is to the upstream. Optional placeholder substitution via `X-Substitute-Body`.",
  content: { "*/*": {} },
} as const;

type ProxyVerb = "get" | "post" | "put" | "patch" | "delete";

function makeProxyOperation(verb: ProxyVerb) {
  const summaries: Record<ProxyVerb, string> = {
    get: "Proxy a GET request to an integration with server-side credential injection",
    post: "Proxy a POST request to an integration with server-side credential injection",
    put: "Proxy a PUT request to an integration with server-side credential injection",
    patch: "Proxy a PATCH request to an integration with server-side credential injection",
    delete: "Proxy a DELETE request to an integration with server-side credential injection",
  };
  const operationIds: Record<ProxyVerb, string> = {
    get: "credentialProxyGet",
    post: "credentialProxyPost",
    put: "credentialProxyPut",
    patch: "credentialProxyPatch",
    delete: "credentialProxyDelete",
  };

  const op: Record<string, unknown> = {
    operationId: operationIds[verb],
    tags: ["Credential Proxy"],
    summary: summaries[verb],
    description: proxySharedDescription,
    security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
    parameters: proxyParameters,
    responses: proxyResponses,
  };

  // GET and DELETE conventionally carry no body — skip requestBody to keep the
  // OpenAPI lint clean and reflect HTTP semantics.
  if (verb === "post" || verb === "put" || verb === "patch") {
    op.requestBody = proxyRequestBody;
  }

  return op;
}

export const credentialProxyPaths = {
  "/api/credential-proxy/proxy": {
    get: makeProxyOperation("get"),
    post: makeProxyOperation("post"),
    put: makeProxyOperation("put"),
    patch: makeProxyOperation("patch"),
    delete: makeProxyOperation("delete"),
  },
} as const;
