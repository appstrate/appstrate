// SPDX-License-Identifier: Apache-2.0

import { problemContent } from "../responses.ts";

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
  "scope (carried by a key created with `scopes` omitted or empty when its creator holds " +
  "it) or an OIDC-issued JWT (device-flow access token for the interactive CLI, dashboard " +
  "access token for second-party apps). Cookie sessions are rejected. Session binding " +
  "pins the `X-Session-Id` to the first principal (API key or JWT user) that used it.\n\n" +
  "Optional `Appstrate-User` header scopes the call to an end-user's connection " +
  "(API-key auth only).\n\n" +
  "URL and headers can contain `{{credential_field}}` placeholders substituted " +
  "against the integration's credential schema. Set `X-Substitute-Body: 1` to run " +
  "the same substitution on the request body (verbs that carry one).\n\n" +
  "Boolean control headers (`X-Substitute-Body`, `X-Stream-Request`, `X-Stream-Response`) " +
  "take `1` or `0`; any other value is a 400.\n\n" +
  "Every response carries RFC 9209 `Proxy-Status`: `appstrate; received-status=<n>` on an " +
  "upstream response relayed whatever its status (a relayed 401 carries no platform " +
  "`WWW-Authenticate` challenge — it is the upstream refusing the connection's credential), " +
  "`appstrate; error=<type>` on a response the proxy produced itself, whose problem `code` " +
  "names the cause.";

/** RFC 9209 `Proxy-Status` — shared with the LLM proxy paths. */
export const PROXY_STATUS_HEADER = {
  "Proxy-Status": {
    description:
      "RFC 9209. `appstrate; received-status=<n>`: the upstream's response, relayed. " +
      "`appstrate; error=<type>` (RFC 9209 §2.3 error type): the proxy's own response. " +
      "Bare `appstrate`: served by the proxy without contacting the upstream (a cache hit).",
    schema: { type: "string", example: "appstrate; received-status=401" },
  },
} as const;

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
      "a `Content-Length` over `max_streamed_body_size`) do not carry this header. Any other " +
      "upstream status is relayed the same way (`default`).",
    headers: {
      ...PROXY_STATUS_HEADER,
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
      "Missing or malformed control header, `invalid_request` — a header the caller sent " +
      "is no valid HTTP field value before any substitution (the detail names the header, " +
      "never the value) —, a finished `X-Run-Id` run, " +
      "`connection_not_in_run` — `X-Connection-Id` names a connection the `X-Run-Id` run " +
      "did not bind —, `connection_not_in_org_default` — it names a connection outside the " +
      "integration's enforced org default — or `unresolved_placeholder` — the target, a " +
      "header or the substituted body names a `{{field}}` the connection does not hold.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "401": {
    description:
      "The caller's credential was refused (problem body, `WWW-Authenticate` challenge, " +
      "`Proxy-Status: appstrate; error=proxy_internal_response`), or the upstream refused the " +
      "connection's (relayed body, `Proxy-Status: appstrate; received-status=401`, no " +
      "challenge). On a relayed streaming-upload 401, `X-Auth-Refreshed: true` means the " +
      "credentials were refreshed server-side but the body could not be replayed — the caller " +
      "replays the call itself.",
    headers: {
      ...PROXY_STATUS_HEADER,
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
      "Forbidden. `unauthorized_target` — the target or a redirect hop is not in " +
      "`authorized_uris`, or the connection does not render the declared list " +
      "(`Proxy-Status` error `http_request_denied`); `blocked_target` — it resolves into a " +
      "blocked network range (`destination_ip_prohibited`); " +
      "`credential_exfiltration_refused` — the call carries a credential and the allowlist " +
      "does not name its hosts (`http_request_denied`); `forbidden` — principal lacks " +
      "`credential-proxy:call`, session bound to a different principal, cookie session " +
      "used, or `X-Run-Id` names another actor's run.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "404": {
    description:
      "`credential_not_found` — no credentials or connection for the requested integration, " +
      "including when no connection of it is accessible to the caller, when the `X-Run-Id` " +
      "run bound none, or when the integration has no published version; `not_found` when " +
      "`X-Run-Id` names no run of this space, or when the integration is not active in this " +
      "space.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
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
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "413": {
    description: "Request body (streaming upload) exceeds MAX_STREAMED_BODY_SIZE (100 MB).",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalServerError" },
  "502": {
    description:
      "`upstream_unresolvable` — the target's host has no DNS answer (`Proxy-Status` error " +
      "`dns_error`); `upstream_unreachable` — the connection to it failed, or the relayed " +
      "body broke off after its headers (`destination_unavailable`); `credential_unusable` — " +
      "a header the connection's credential is substituted or injected into would not be a " +
      "valid HTTP field value (CR, LF, NUL, another control character or a character above " +
      "U+00FF); nothing was sent, the detail names the header, never the value " +
      "(`proxy_configuration_error`).",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "504": {
    description:
      "`upstream_timeout` — the upstream did not answer, or did not finish a buffered body, " +
      "within the 30 s deadline (`Proxy-Status` error `http_response_timeout`).",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  default: {
    description:
      "An upstream response relayed verbatim at the upstream's own status (a status listed " +
      "above included) with its headers and body, marked `Proxy-Status: appstrate; " +
      "received-status=<n>` — which is how a caller tells it from the proxy's own problem " +
      "document. `Set-Cookie` is never relayed.",
    headers: PROXY_STATUS_HEADER,
    content: { "*/*": {} },
  },
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

const callsParameterNames = new Set([
  "X-Space-Id",
  "X-Integration-Id",
  "X-Session-Id",
  "X-Connection-Id",
  "X-Run-Id",
]);

const callsOperation = {
  operationId: "credentialProxyCalls",
  tags: ["Credential Proxy"],
  summary: "Run several independent proxy calls in one request",
  description:
    "Runs up to `CREDENTIAL_PROXY_LIMITS.max_calls` independent upstream calls of ONE integration " +
    "in one request. Not a provider batch protocol: each call goes through exactly the " +
    "`/proxy` pipeline (same `authorized_uris` allowlist, same credential injection, same egress " +
    "guard, same 401 refresh-and-retry), so a call refused on `/proxy` is refused here and the " +
    "other calls are unaffected. The caller's `Authorization` header in a call is never " +
    "forwarded.\n\n" +
    "Integration, connection selection (`X-Connection-Id`, `X-Run-Id`) and session " +
    "(`X-Session-Id`) are set once on the envelope. Results come back in request order. " +
    "A result with `error` is a call the platform answered itself, with the `status` and `code` " +
    "`/proxy` would have answered (`unauthorized_target`, `upstream_timeout`, …), or " +
    "`503 not_attempted` for a call left unsent because the envelope ran out of time (nothing " +
    "reached the upstream; safe to retry). Otherwise `status`, `headers` and `body` are the " +
    "upstream's. Calls run with bounded concurrency and no call starts after 25 s, so the " +
    "request stays under a 60 s idle cut; the response size budget (`max_response_bytes`) is " +
    "split equally between the calls, an over-cap body is cut and flagged `truncated`, and it " +
    "also bounds the encoded envelope: a result that would push it over comes back with " +
    "`body: null` and `truncated: true`.\n\n" +
    "A failure about the connection or the integration rather than one call's target (no " +
    "reachable connection, several to choose from, integration inactive, unusable credential) " +
    "fails the whole envelope once, with the same problem `/proxy` answers " +
    "(`candidate_connections` included), before any other call is sent.\n\n" +
    "Rate limit: the envelope costs one point of the route budget " +
    "(`rate_per_min`) and one point per call of the per-identity `calls_per_min` budget. " +
    "Same bearer-only authentication as `/proxy`.",
  security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
  parameters: proxyParameters.filter((p) => callsParameterNames.has(p.name)),
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["calls"],
          additionalProperties: false,
          properties: {
            calls: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["method", "target"],
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                    pattern: "^[\\w.:-]{1,64}$",
                    description: "Label echoed in the result; defaults to the call's index.",
                  },
                  method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                  target: {
                    type: "string",
                    description: "Same meaning as `X-Target` on `/proxy`.",
                  },
                  headers: { type: "object", additionalProperties: { type: "string" } },
                  body: {
                    type: "string",
                    description: "UTF-8 request body. POST, PUT and PATCH only.",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  responses: {
    "200": {
      description: "One result per call, in request order.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["results"],
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "status"],
                  properties: {
                    id: { type: "string" },
                    status: { type: "integer" },
                    headers: { type: "object", additionalProperties: { type: "string" } },
                    body: { type: ["string", "null"] },
                    body_encoding: { type: "string", enum: ["utf8", "base64"] },
                    truncated: { type: "boolean", enum: [true] },
                    error: {
                      type: "object",
                      required: ["code", "message"],
                      properties: { code: { type: "string" }, message: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "400": proxyResponses["400"],
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": proxyResponses["403"],
    "404": proxyResponses["404"],
    "409": proxyResponses["409"],
    "413": proxyResponses["413"],
    "429": proxyResponses["429"],
    "500": proxyResponses["500"],
  },
} as const;

export const credentialProxyPaths = {
  "/api/credential-proxy/proxy": {
    get: makeProxyOperation("get"),
    post: makeProxyOperation("post"),
    put: makeProxyOperation("put"),
    patch: makeProxyOperation("patch"),
    delete: makeProxyOperation("delete"),
  },
  "/api/credential-proxy/calls": {
    post: callsOperation,
  },
} as const;
