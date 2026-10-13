// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";
import { problemContent } from "../responses.ts";

/**
 * Credential proxy endpoint: a remote runner's calls for its run (`X-Run-Id`), and
 * direct calls on the caller's own connections outside any run.
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
  "Authentication: bearer only — an API key or an OIDC-issued JWT (device-flow access " +
  "token for the interactive CLI, dashboard access token for second-party apps). Cookie " +
  "sessions are rejected. Session binding pins the `X-Session-Id` to the first principal " +
  "(API key or JWT user) that used it.\n\n" +
  "A call takes one of two paths, each with its own permission. **For a run** (`X-Run-Id`): " +
  "requires `credential-proxy:call` — launching runs (`agents:run`) does not open it; the " +
  "header names the caller's own in-flight run that the caller executes itself (a remote " +
  "run), and the call reaches the connections that run bound, a connection another member " +
  "shared into the space included. **Outside a run** (no " +
  "`X-Run-Id`): requires `credential-proxy:direct`, and reaches the caller's OWN connections " +
  "only — `GET /api/credential-proxy/connections` lists them. A connection another member " +
  "shared into the space, and every connection of an integration governed by an enforced " +
  "org default, is reached through a run. Holding one permission never opens the other " +
  "path.\n\n" +
  "Optional `Appstrate-User` header scopes the call to an end-user's connection " +
  "(API-key auth only).\n\n" +
  "URL and headers can contain `{{credential_field}}` placeholders substituted " +
  "against the integration's credential schema, each value encoded for the place it " +
  "takes: percent-encoded as one URL component (a placeholder that starts the URL is a " +
  "base URL, inserted as is), a header value as is. Set `X-Substitute-Body: 1` to " +
  "substitute the request body too (verbs that carry one), each value escaped for the " +
  "body's `Content-Type`: JSON (a value inside a string literal is escaped, a bare " +
  "`{{field}}` becomes a JSON string), form, XML, multipart (a value holding a line break " +
  "or the boundary delimiter is refused; in a part header a placeholder must sit inside a " +
  'quoted string, where a value holding `"` or `\\` is refused) or `text/plain` (as is). ' +
  "A body holding a placeholder under any other `Content-Type`, under none, or under one " +
  "that itself holds a placeholder, is a 400 `invalid_request`, as is one header name " +
  "written twice in different case; a body with no placeholder is sent untouched. " +
  "A value its place cannot carry (a line break in a header, a character outside RFC 6265 " +
  "`cookie-octet` in a `Cookie` header, a path segment rendered `.` or `..`) is a " +
  "`credential_unusable` naming the placeholder, never encoded around. So is a path " +
  "segment a field leaves empty (`/x/{{field}}` with an unset optional field): either the " +
  "connection lacks the value or the target should not use it.\n\n" +
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
      "are substituted, each value escaped for the body's `Content-Type`, which must " +
      "then be JSON, form, XML, multipart or `text/plain`. Ignored on " +
      "verbs that do not carry a body (GET, DELETE).",
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
      "(`appstrate run --report`). Requires `credential-proxy:call`. Must name an in-flight " +
      "run of the calling actor in this space, executed by the caller (`runOrigin: remote`): an " +
      "unknown id or one of another space is a `404`, another actor's run or a run the " +
      "platform executes a `403`, a finished run a `400`. It binds the call to the run's " +
      "snapshot: the call reaches ONLY the " +
      "connections the run's kickoff bound to the integration (every layer applied, agent-level " +
      "ones included — admin pins, enforced defaults, launch overrides, member pins): one bound " +
      "connection is used; several require `X-Connection-Id` naming one of them " +
      "(`409 must_choose_connection` when absent, `400 connection_not_in_run` when it names " +
      "another); none is a `404`, and so is a bound one no longer reachable (deleted or " +
      "unshared); a bound one that needs reconnecting is a " +
      "`409 needs_reconnection`. Without it the call is made outside a run: it requires " +
      "`credential-proxy:direct` and reaches the caller's own connections only, as described " +
      "under `X-Connection-Id`.",
    schema: { type: "string" },
  },
  {
    name: "X-Connection-Id",
    in: "header",
    required: false,
    description:
      "Optional explicit connection UUID. With `X-Run-Id`, it must name a connection the run " +
      "bound (see `X-Run-Id`). Without it, only the caller's own connections (user or end-user) " +
      "usable in the request's space are candidates — no org default applies, a soft one " +
      "included — in this order: (1) an integration governed by an ENFORCED org default answers " +
      "`403 run_required` whatever is named; (2) a named connection is used when it is one of " +
      "the caller's own, of the requested integration; any other id — another member's " +
      "connection, shared into the space or not, or an unknown id — is one and the same " +
      "`404 credential_not_found`; (3) nothing named: exactly one own connection is used, none " +
      "is a `404 credential_not_found`, several a `409 must_choose_connection` listing them. A " +
      "connection whose credentials need reconnecting is a `409 needs_reconnection`. A non-uuid " +
      "value is a `400`.",
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
      "did not bind — or `unresolved_placeholder` — the target, a " +
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
      "does not name its hosts: it is empty or has an entry that leaves the host to the " +
      "caller, or every entry matching the target reaches it through a wildcard past the " +
      "registrable domain written under it, judged with the Public Suffix List (the message " +
      "then names the host to list) (`http_request_denied`); `run_required` — no `X-Run-Id` " +
      "and an enforced org default governs the integration in this space: its connections are " +
      "reached through a run only (`http_request_denied`); `forbidden` — the principal lacks " +
      "the permission of the path the call takes (`credential-proxy:call` with `X-Run-Id`, " +
      "`credential-proxy:direct` without, the detail naming it), session " +
      "bound to a different principal, cookie session used, or `X-Run-Id` names another " +
      "actor's run or a run the platform executes.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "404": {
    description:
      "`credential_not_found` — no credentials or connection for the requested integration: " +
      "the `X-Run-Id` run bound none, or (no run) the caller owns none usable in this space or " +
      "`X-Connection-Id` names anything but one of them — the body is the same whether the id " +
      "is another member's connection, shared or not, or no connection at all —, or the " +
      "integration has no published version; `not_found` when " +
      "`X-Run-Id` names no run of this space, or when the integration is not active in this " +
      "space.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "409": {
    description:
      "`must_choose_connection` — no `X-Connection-Id` and no single candidate: the " +
      "`X-Run-Id` run bound several connections to the integration, or (no run) the caller " +
      "owns several. `errors[0].candidate_connections` lists what the caller may name (the " +
      "run's bound set, else the caller's own connections — never another member's), with " +
      "`label`, `account_id`, `owned_by_actor`, `needs_reconnection`; retry with one `id` in " +
      "`X-Connection-Id`. `needs_reconnection` — the connection that would be bound (the run's " +
      "bound one included) needs its owner to reconnect it.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "413": {
    description: "Request body (streaming upload) exceeds MAX_STREAMED_BODY_SIZE (100 MB).",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": {
    description:
      "`session_store_unavailable` — the upstream WAS called and answered, but the cookies it " +
      "set could not be saved to the session's server-side jar, so its response is withheld " +
      "and later calls of the session would miss them. Not a `503`: the call took effect " +
      "upstream, so a blind retry repeats it (`Proxy-Status` error `proxy_internal_error`). " +
      "`internal_error` — an unexpected failure of the proxy itself.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "502": {
    description:
      "`upstream_unresolvable` — the target's host has no DNS answer (`Proxy-Status` error " +
      "`dns_error`); `upstream_unreachable` — the connection to it failed, or the relayed " +
      "body broke off after its headers (`destination_unavailable`); `credential_unusable` — " +
      "a value of the connection cannot be sent where the call places it: a header it is " +
      "substituted or injected into would not be a valid HTTP field value, or a `{{field}}` " +
      "of the target, a header or the body takes a value its place cannot carry (or leaves a " +
      "path segment empty). Nothing was sent; the detail names the header or the " +
      "`{{field}}`, never the value (`proxy_configuration_error`).",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "503": {
    description:
      "`encryption_key_unavailable` — the connection's stored credential is encrypted under a " +
      "key id missing from the platform's keyring. Operator configuration: nothing was sent, " +
      "the connection is not flagged, and the call succeeds once the key is restored " +
      "(`Proxy-Status` error `proxy_configuration_error`).",
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

/** One connection `GET /api/credential-proxy/connections` lists. */
const directProxyConnectionSchema = {
  type: "object",
  required: [
    "integration_package_id",
    "connection_id",
    "label",
    "auth_key",
    "scopes_granted",
    "authorized_uris",
    "allow_all_uris",
    "needs_reconnection",
    "run_required",
  ],
  properties: {
    integration_package_id: {
      type: "string",
      description: "Integration package id: the `X-Integration-Id` of a call.",
    },
    connection_id: {
      type: "string",
      format: "uuid",
      description: "The `X-Connection-Id` that names this connection.",
    },
    label: { type: "string" },
    auth_key: { type: "string", description: "The manifest auth the connection is on." },
    scopes_granted: { type: "array", items: { type: "string" } },
    authorized_uris: {
      type: "array",
      items: { type: "string" },
      description:
        "The auth's `authorized_uris`: what `X-Target` and every redirect hop are matched " +
        "against. A literal entry is given as is, an entry templated on a connection variable " +
        "(`{$variable.<name>}`) rendered for this connection, or omitted when the connection " +
        "does not render it. An entry templated on a credential field (`{$credential.<field>}`) " +
        "is given as the manifest declares it, never rendered: the proxy resolves it " +
        "server-side from the stored credential, whose values this list never carries. To " +
        "call such a target, write `{{<field>}}` in `X-Target` where the entry has " +
        "`{$credential.<field>}`: `{{webhook_url}}` for an entry that is " +
        "`{$credential.webhook_url}` alone (the field holds the whole URL), " +
        "`https://{{host}}/v1/items` for `https://{$credential.host}/**`.",
    },
    allow_all_uris: {
      type: "boolean",
      description:
        "The auth sets `allow_all_uris`. Ignored on a call that places a `{{credential_field}}`: " +
        "see `X-Target`.",
    },
    needs_reconnection: {
      type: "boolean",
      description: "A call binding it answers `409 needs_reconnection` until it is reconnected.",
    },
    run_required: {
      type: "boolean",
      description:
        "An enforced org default governs the integration in this space: a call without " +
        "`X-Run-Id` answers `403 run_required`, this connection named or not.",
    },
  },
} as const;

export const credentialProxyPaths = {
  "/api/credential-proxy/connections": {
    get: {
      operationId: "listCredentialProxyConnections",
      tags: ["Credential Proxy"],
      summary: "List the connections the caller can call outside a run",
      description:
        "What a call to `/api/credential-proxy/proxy` without `X-Run-Id` can reach in this " +
        "space: the caller's OWN connections (user or end-user) usable here, of the " +
        "integrations active in the space that have a published version. Read with the rule " +
        "the proxy applies, so a connection another member shared into the space is never " +
        "listed — it is reached through a run. Grouped by integration, oldest first within " +
        "one. An integration with several entries needs `X-Connection-Id`; `run_required` and " +
        "`needs_reconnection` tell which entries a call would still refuse. No credential is " +
        "decrypted to build it. Requires `credential-proxy:direct`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "The caller's directly callable connections",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: directProxyConnectionSchema },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/credential-proxy/proxy": {
    get: makeProxyOperation("get"),
    post: makeProxyOperation("post"),
    put: makeProxyOperation("put"),
    patch: makeProxyOperation("patch"),
    delete: makeProxyOperation("delete"),
  },
} as const;
