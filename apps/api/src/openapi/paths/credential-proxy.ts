// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";
import { problemContent } from "../responses.ts";
import { proxyConnectionVerdictProperties } from "./integrations.ts";

/**
 * Credential proxy endpoint: a remote runner's calls for its run (`X-Run-Id`), and
 * calls outside any run.
 *
 * Accepts bearer auth: API keys (headless / GitHub Action) or OIDC-issued JWTs
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
  "Two permissions govern it; `credential-proxy:call` implies `credential-proxy:call-own`. " +
  "**For a run** (`X-Run-Id`): requires `credential-proxy:call` — launching runs " +
  "(`agents:run`) does not grant it; the header names the caller's own in-flight run that " +
  "the caller executes itself (a remote run), and the call reaches the connections that run " +
  "bound, a connection another member shared into the space included. **Outside a run** " +
  "(no `X-Run-Id`): with `credential-proxy:call` the call reaches the connections usable " +
  "in the space, the caller's own and those shared into it, through the resolver's cascade " +
  "without agent pins (org defaults included): the rows a run in the space binds for that " +
  "caller. With `credential-proxy:call-own` alone it reaches the caller's OWN connections " +
  "only: a connection another member shared into the space is out of reach, and so is " +
  "every connection of an integration governed by an enforced org default; a call for a " +
  "run is refused. `GET /api/credential-proxy/connections` lists the candidates of a call " +
  "outside a run and, per row, what such a call would still refuse. A call outside a run in a " +
  "space whose `credential_proxy_open` is `false` answers `403 credential_proxy_closed`, " +
  "whatever the caller's role; a call for a run is not affected.\n\n" +
  "Optional `Appstrate-User` header (API-key auth only) makes that end-user the caller: " +
  "outside a run the call reaches the end-user's own connections, and with " +
  "`credential-proxy:call` those a member shared into the space.\n\n" +
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
  "An `Idempotency-Key` header is the upstream's here (Stripe's, for one): it is relayed with " +
  "the caller's other headers, whatever the verb. The platform de-duplicates nothing on it, " +
  "so it is not a parameter of this operation and no `Idempotent-Replayed` is answered.\n\n" +
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
      "call is refused when that list is empty. A redirect to a URL outside " +
      "`authorized_uris` is not followed: the upstream's 3xx is returned as is (status, " +
      "`Location`, body) and nothing is sent to that URL, so the caller can fetch a signed " +
      "URL itself. On a call that substitutes a `{{credential_field}}` such a redirect is " +
      "refused instead (`403 unauthorized_target`): its `Location` could carry the " +
      "substituted value.",
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
    description:
      "Impersonation header — the end-user is the caller: outside a run the call reaches " +
      "their own connections, and with `credential-proxy:call` those a member shared into the " +
      "space.",
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
      "`409 needs_reconnection`. Without it the call is made outside a run and reaches what " +
      "`X-Connection-Id` describes.",
    schema: { type: "string" },
  },
  {
    name: "X-Connection-Id",
    in: "header",
    required: false,
    description:
      "Optional explicit connection UUID. With `X-Run-Id`, it must name a connection the run " +
      "bound (see `X-Run-Id`). Without it, what is reachable depends on the caller's " +
      "permissions.\n\n" +
      "**`credential-proxy:call-own` without `credential-proxy:call`**: only the caller's own " +
      "connections (user or end-user) usable in the request's space are candidates — no org " +
      "default applies, a soft one included — in this order: (1) an integration governed by " +
      "an ENFORCED org default answers `403 call_permission_required` whatever is named; (2) " +
      "a named connection is used when it is " +
      "one of the caller's own, of the requested integration; any other id — another member's " +
      "connection, shared into the space or not, or an unknown id — is one and the same " +
      "`404 credential_not_found`; (3) nothing named: exactly one own connection is used, none " +
      "is a `404 credential_not_found`, several a `409 must_choose_connection` listing them.\n\n" +
      "**With `credential-proxy:call`**: the candidates are the caller's own " +
      "connections and those another member shared into the space, in this order: (1) an " +
      "ENFORCED org default of the integration binds its set — a named id must be a member " +
      "(`400 connection_not_in_org_default` otherwise, whatever the id names); (2) a named " +
      "connection is used when it is one of the candidates, of the requested integration; any " +
      "other id — a connection not shared into the space or an unknown id — is one and the " +
      "same `404 credential_not_found`; (3) a SOFT org default binds its set; (4) nothing " +
      "named and no default: exactly one own connection is used; several, or none while a " +
      "shared one is a candidate, is a `409 must_choose_connection` listing the candidates — a " +
      "shared connection is used only when named or designated by an org default; no " +
      "candidate at all is a `404 credential_not_found`. A " +
      "default set of one is used, several are a `409 must_choose_connection` over the set " +
      "(an enforced default then takes one of its members, a soft one any candidate). With " +
      "nothing named, a default's whole set is checked as a run's would be, before any " +
      "choice is offered: a member the caller cannot reach answers " +
      "`409 pinned_connection_unavailable` and one that needs reconnecting " +
      "`409 needs_reconnection`, even when another member would serve; a named member that " +
      "passes those checks is used.\n\n" +
      "Either way a connection that would be used and needs reconnecting, a default's member " +
      "included, is a `409 needs_reconnection`, and a non-uuid value a `400`.",
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
      "did not bind —, `connection_not_in_org_default` — no `X-Run-Id`, and it names a " +
      "connection outside the integration's enforced org default — or " +
      "`unresolved_placeholder` — the target, a " +
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
      "forced refresh served a credential to retry with but the body could not be replayed — " +
      "the caller replays the call itself. A relayed 401 the forced refresh could not recover from carries " +
      "`X-Appstrate-Credential-Status`.",
    headers: {
      ...PROXY_STATUS_HEADER,
      "X-Appstrate-Credential-Status": {
        description:
          "Set by the platform (never relayed from the upstream) on a relayed 401 after a " +
          "forced refresh that left the rejected credential in place. An RFC 8941 Item: " +
          "`in_use; cause=<cause>[; failures=<n>; max-failures=<max>]` — the credential stays " +
          "in use, and `failures` counts this rejection toward `INTEGRATION_REFRESH_MAX_FAILURES` " +
          "when it was counted — or `needs_reconnection; cause=<cause>` — the connection is now " +
          "flagged `needs_reconnection` and its owner must reconnect it. `cause` is the credential-failure vocabulary " +
          "(`refresh_token_revoked`, `unrefreshable`, `upstream_transient`, …). Absent: no " +
          "refresh verdict, the upstream refused the request itself.",
        schema: {
          type: "string",
          pattern:
            "^(in_use; cause=[a-z_]+(; failures=[0-9]+; max-failures=[0-9]+)?|needs_reconnection; cause=[a-z_]+)$",
        },
      },
      "X-Auth-Refreshed": {
        description:
          "Present and set to `true` on a streaming-upload 401 where the forced refresh served " +
          "a credential to retry with but the body could not be replayed (absent when it did " +
          "not: `X-Appstrate-Credential-Status` says why). Signals the caller to retry.",
        schema: { type: "string", enum: ["true"] },
      },
    },
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
  "403": {
    description:
      "Forbidden. `unauthorized_target` — the target is not in `authorized_uris`, or, on a " +
      "call that substitutes a `{{credential_field}}`, a redirect hop is not (any other call " +
      "gets that 3xx back unfollowed), or the connection does not render the declared list " +
      "(`Proxy-Status` error `http_request_denied`); `blocked_target` — it resolves into a " +
      "blocked network range (`destination_ip_prohibited`); " +
      "`credential_exfiltration_refused` — the call carries a credential and the allowlist " +
      "does not name its hosts: it is empty or has an entry that leaves the host to the " +
      "caller, or every entry matching the target reaches it through a wildcard past the " +
      "registrable domain written under it, judged with the Public Suffix List (the message " +
      "then names the host to list) (`http_request_denied`); `call_permission_required` — no " +
      "`X-Run-Id`, an enforced org default governs the integration in this space and the " +
      "caller holds `credential-proxy:call-own` without `credential-proxy:call` " +
      "(`http_request_denied`); `credential_proxy_closed` — no `X-Run-Id`, and the space's " +
      "`credential_proxy_open` is `false`, whatever the caller's role " +
      "(`proxy_internal_response`); `forbidden` — the principal lacks the permission of the path " +
      "the call takes (`credential-proxy:call` with `X-Run-Id`, `credential-proxy:call-own` " +
      "or `credential-proxy:call` without), session " +
      "bound to a different principal, cookie session used, or `X-Run-Id` names another " +
      "actor's run or a run the platform executes.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "404": {
    description:
      "`credential_not_found` — no credentials or connection for the requested integration: " +
      "the `X-Run-Id` run bound none, or (no run) the caller reaches none in this space or " +
      "`X-Connection-Id` names nothing the caller reaches there (see `X-Connection-Id`) — the " +
      "body is the same whether the id is another member's connection out of reach or no " +
      "connection at all —, or the integration has no published version; `not_found` when " +
      "`X-Run-Id` names no run of this space, or when the integration is not active in this " +
      "space.",
    headers: PROXY_STATUS_HEADER,
    content: problemContent,
  },
  "409": {
    description:
      "`must_choose_connection` — no `X-Connection-Id` and no single candidate: the " +
      "`X-Run-Id` run bound several connections to the integration, or (no run) the caller " +
      "owns several, an org default holds several, or a caller holding " +
      "`credential-proxy:call` owns none while a shared one is a candidate. " +
      "`errors[0].candidate_connections` lists what the caller may name (the run's bound " +
      "set, else the org default's set, else the caller's own connections — with those " +
      "shared into the space for a caller holding `credential-proxy:call`, never another " +
      "member's otherwise), with " +
      "`label`, `account_id`, `owned_by_actor`, `needs_reconnection`; retry with one `id` in " +
      "`X-Connection-Id`. `needs_reconnection` — the connection that would be bound (the run's " +
      "bound one included) needs its owner to reconnect it. `pinned_connection_unavailable` — " +
      "no `X-Run-Id`: a member of the ORG DEFAULT that binds the call is out of the caller's " +
      "reach (this path applies no agent pin); `errors[0].source` names the layer, " +
      "`org_default_enforced` or `org_default`.",
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
const connectionOutsideRunSchema = {
  type: "object",
  required: [
    "integration_package_id",
    "connection_id",
    "label",
    "owned_by_actor",
    "auth_key",
    "scopes_granted",
    "authorized_uris",
    "allow_all_uris",
    "needs_reconnection",
    "call_permission_required",
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
    owned_by_actor: {
      type: "boolean",
      description:
        "True when the connection is the caller's own, false when another member shared it in " +
        "the space: listed for a caller holding `credential-proxy:call`, and used " +
        "when named or designated by an org default.",
    },
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
    call_permission_required: {
      type: "boolean",
      description:
        "An enforced org default governs the integration in this space and the caller holds " +
        "no `credential-proxy:call`: their call without `X-Run-Id` answers " +
        "`403 call_permission_required`, this connection named or not.",
    },
  },
} as const;

/** An integration without a usable connection, as `GET /api/credential-proxy/tools` lists it. */
const notReadyIntegrationSchema = {
  type: "object",
  required: ["integration_package_id", "display_name", "proxy_connection"],
  additionalProperties: false,
  properties: {
    integration_package_id: {
      type: "string",
      description: "Integration package id: the `X-Integration-Id` of a call.",
    },
    display_name: { type: "string" },
    proxy_connection: {
      type: "object",
      required: ["status", "imposed"],
      additionalProperties: false,
      description:
        "What a call naming no connection gets for this caller, as the integration detail's " +
        "`proxy_connection` states it, judged against the latest published version: one of " +
        "`none`, `needs_reconnection`, `not_permitted`, `default_unavailable`, `unusable`.",
      properties: proxyConnectionVerdictProperties,
    },
    refusal: {
      $ref: "#/components/schemas/ResolutionFieldError",
      description:
        "Present when the verdict is a refusal the selection describes: the `not_connected` " +
        "item of `none` (with the `auth_key` and `required_scopes` a connect flow targets), " +
        "else the first item of the refusal (`needs_reconnection`, " +
        "`pinned_connection_unavailable`…). Absent on `not_permitted`.",
    },
  },
} as const;

const { integration_package_id: _toolIntegration, ...toolConnectionProperties } =
  connectionOutsideRunSchema.properties;

/** One tool `GET /api/credential-proxy/tools` lists. */
const integrationToolSchema = {
  type: "object",
  required: ["name", "kind", "integration_package_id", "description", "connections"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      description:
        "The tool's name: `{ns}__api_call` (`{ns}__api_call__{auth}` when several auths of " +
        "the integration expose one) or `{ns}__{tool}` for a typed tool, `{ns}` being the " +
        "package id normalised, with a suffix hashed from the package id when another " +
        "integration active in the space normalises alike.",
    },
    kind: {
      type: "string",
      enum: ["api_call", "remote"],
      description:
        "`api_call`: called through `/api/credential-proxy/proxy` with one of `connections`; " +
        "`remote`: a typed tool of the integration's MCP server, called through " +
        "`/api/credential-proxy/tools/call` by its `remote_name`.",
    },
    integration_package_id: {
      type: "string",
      description: "Integration package id: the `X-Integration-Id` of a call.",
    },
    description: { type: "string" },
    auth_key: {
      type: "string",
      description: "`api_call` only: the auth whose connections it reaches.",
    },
    connection_required: {
      type: "boolean",
      description:
        "`api_call` only: the integration also has connections of another auth, so a call " +
        "names one of `connections` (`X-Connection-Id`).",
    },
    remote_name: {
      type: "string",
      description:
        "`remote` only: the name the server lists the tool by, which `tools/call` takes.",
    },
    input_schema: {
      type: "object",
      additionalProperties: true,
      description: "`remote` only: the tool's input schema, sanitised as in a run.",
    },
    catalog_unreadable: {
      type: "boolean",
      enum: [true],
      description:
        "`remote` only: the server's `tools/list` could not be read, so the tool is a declared " +
        "name, without description and with an empty object schema.",
    },
    connections: {
      type: "array",
      description:
        "The connections it reaches, as `GET /api/credential-proxy/connections` lists them.",
      items: {
        type: "object",
        required: connectionOutsideRunSchema.required.filter(
          (field) => field !== "integration_package_id",
        ),
        properties: {
          ...toolConnectionProperties,
          missing_scopes: {
            type: "array",
            items: { type: "string" },
            description:
              "`remote` only: the scopes the tool's `tools_policy` entry requires on the " +
              "connection's auth that it lacks; a call with it answers `409 insufficient_scopes`.",
          },
        },
      },
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
        "What a call to `/api/credential-proxy/proxy` without `X-Run-Id` would accept from " +
        "this caller in this space, of the integrations active in the space that have a " +
        "published version. Read with the rule the proxy applies. With " +
        "`credential-proxy:call-own` alone: the caller's OWN connections (user or end-user) " +
        "usable here, and never one another member shared into the space. With " +
        "`credential-proxy:call`: those and the connections shared into the " +
        "space, each telling which it is (`owned_by_actor`); of an integration governed by an " +
        "enforced org default, that default's members only. Grouped by integration, oldest " +
        "first within one. An entry the caller does not own is used when named with " +
        "`X-Connection-Id` or designated by an org default. `call_permission_required` and " +
        "`needs_reconnection` describe a call NAMING that entry with `X-Connection-Id`. A call " +
        "naming none follows the order that parameter describes on " +
        "`/api/credential-proxy/proxy`: several own entries of one integration need it, and " +
        "with `credential-proxy:call` an org default binds its set before the caller's own " +
        "connection, refusing the call while one of its members is out of the caller's reach " +
        "or needs reconnecting. No credential is decrypted to build it. Requires " +
        "`credential-proxy:call-own` or `credential-proxy:call`. A space whose " +
        "`credential_proxy_open` is `false` answers `403 credential_proxy_closed`, whatever the " +
        "caller's role.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "The connections the caller can call outside a run",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: connectionOutsideRunSchema },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "`forbidden` — the principal holds neither `credential-proxy:call-own` nor " +
            "`credential-proxy:call`; `credential_proxy_closed` — the space's " +
            "`credential_proxy_open` is `false`.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/credential-proxy/tools": {
    get: {
      operationId: "listIntegrationTools",
      tags: ["Credential Proxy"],
      summary: "List the tools the caller can call outside a run",
      description:
        "Every tool a call outside a run reaches in this space, for this caller: each " +
        "integration's `api_call` tools (called through `/api/credential-proxy/proxy`) whose " +
        "auth has a connection the caller reaches, and, for an integration backed by a remote " +
        "MCP server, the typed tools that server offers (called through " +
        "`/api/credential-proxy/tools/call`): the integration catalog's selection (its " +
        "`tools_policy` keys, or every tool the server lists when `allow_undeclared_tools` is " +
        "`true`), less `hidden_tools` and the connect tool, described by the server's " +
        "`tools/list`. Each server is listed with the connection the proxy selects (or the " +
        "`connection_id` named, when it is one of that integration's; when the selection asks " +
        "for a choice, the first of the caller's connections it accepts), cached per " +
        "connection and integration version for 5 minutes, and journaled as one call of the " +
        "connection when the listing reaches the server. Each tool carries the connections it " +
        "reaches, the rows of `GET /api/credential-proxy/connections`. `not_ready` lists the " +
        "integrations active in the space the caller has no usable connection of, with the " +
        "verdict of a call naming none; with `X-Appstrate-Connect-Offers: 1`, a refusal item a " +
        "connect flow clears carries a `connect_url`. `unlisted` lists the remote integrations " +
        "whose server the proxy refused to list (connection selection, permission, " +
        "`authorized_uris`, an unrenderable URL), each with that refusal. Read with the access " +
        "rule of `/api/credential-proxy/proxy` without `X-Run-Id`, against each integration's " +
        "latest published version. Requires `credential-proxy:call-own` or " +
        "`credential-proxy:call`. A space whose `credential_proxy_open` is `false` answers " +
        "`403 credential_proxy_closed`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/ConnectOffers" },
        {
          name: "integration_package_id",
          in: "query",
          required: false,
          description:
            "Lists the tools of this integration alone (`@scope/name`); `404` when it is not " +
            "active in the space.",
          schema: { type: "string", minLength: 1 },
        },
        {
          name: "name",
          in: "query",
          required: false,
          description:
            "Resolves the tool of this name alone: an `api_call` tool lists no server, and only " +
            "the remote integrations whose namespace starts the name are listed. `not_ready` is " +
            "then empty.",
          schema: { type: "string", minLength: 1 },
        },
        {
          name: "connection_id",
          in: "query",
          required: false,
          description:
            "The connection the server of the integration it belongs to is listed with, as " +
            "`X-Connection-Id` names one on `/api/credential-proxy/proxy`.",
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description:
            "The tools, sorted by integration, `api_call` tools first within one; a remote " +
            "integration's typed tools follow in the order its server's `tools/list` gives them, " +
            "or, when the server could not be listed (`catalog_unreadable`), its declared names " +
            "in no guaranteed order. A server the proxy refused to list is an entry of " +
            "`unlisted`, never an error status.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tools", "not_ready", "unlisted", "truncated_catalogs"],
                additionalProperties: false,
                properties: {
                  tools: { type: "array", items: integrationToolSchema },
                  not_ready: { type: "array", items: notReadyIntegrationSchema },
                  unlisted: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["integration_package_id", "refusal"],
                      additionalProperties: false,
                      properties: {
                        integration_package_id: { type: "string" },
                        refusal: { $ref: "#/components/schemas/ProblemDetail" },
                      },
                    },
                  },
                  truncated_catalogs: {
                    type: "array",
                    description:
                      "The remote integrations whose server lists more tools than are read: only " +
                      "its first `max_tools` are listed. Empty when `name` is given.",
                    items: {
                      type: "object",
                      required: ["integration_package_id", "max_tools"],
                      additionalProperties: false,
                      properties: {
                        integration_package_id: { type: "string" },
                        max_tools: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "`validation_failed` — an unknown query parameter, an empty `integration_package_id` " +
            "or `name`, or a `connection_id` that is not a uuid (`errors[]` names each).",
          content: problemContent,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "`forbidden` — the principal holds neither `credential-proxy:call-own` nor " +
            "`credential-proxy:call`, or authenticates with a session cookie or another credential " +
            "the bearer-only proxy refuses (the chat's MCP loopback bearer included); " +
            "`credential_proxy_closed` — the space's `credential_proxy_open` is `false`, whatever " +
            "the caller's role. No `Proxy-Status`: nothing is relayed on this route.",
          content: problemContent,
        },
        "404": {
          description:
            "`not_found` — `integration_package_id` names an integration that is not active in " +
            "this space. Without it, an inactive integration is left out of the listing.",
          content: problemContent,
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/credential-proxy/tools/call": {
    post: {
      operationId: "callRemoteIntegrationTool",
      tags: ["Credential Proxy"],
      summary: "Call a typed tool of a remote MCP integration",
      description:
        "One `tools/call` on the integration's remote MCP server, outside a run, for a tool " +
        "`GET /api/credential-proxy/tools` lists by its `remote_name`; a tool outside the " +
        "integration catalog's selection answers " +
        "`404` before any exchange. The exchange goes through the credential proxy with the " +
        "access rule and the connection selection of `/api/credential-proxy/proxy` without " +
        "`X-Run-Id`, against the integration's latest published version, and is journaled as " +
        "one call of the connection. The server's result is relayed without its " +
        '`_meta["dev.appstrate/events"]`; a tool error is a result with `isError: true`. ' +
        "A refusal produced by the credential proxy's own checks or a transport fault carries " +
        "RFC 9209 `Proxy-Status: appstrate; error=<type>` (the 403, 502, 503 and 504 below name " +
        "it); the platform's other refusals and the result carry none. " +
        "Requires `credential-proxy:call-own` or `credential-proxy:call`. A space whose " +
        "`credential_proxy_open` is `false` answers `403 credential_proxy_closed`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/ConnectOffers" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["integration_package_id", "name"],
              additionalProperties: false,
              properties: {
                integration_package_id: {
                  type: "string",
                  minLength: 1,
                  description: "Integration package id (`@scope/name`).",
                },
                connection_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "The connection to call with; omitted, the proxy's selection (`X-Connection-Id` semantics).",
                },
                name: {
                  type: "string",
                  minLength: 1,
                  description: "The tool's name, as the server lists it.",
                },
                arguments: {
                  type: "object",
                  additionalProperties: true,
                  description: "The tool's arguments, following its `input_schema`.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The server's result.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["result"],
                properties: {
                  result: {
                    type: "object",
                    additionalProperties: true,
                    description:
                      "An MCP `CallToolResult` (`content`, optional `structuredContent` and `isError`).",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "`invalid_request` — the body is not valid JSON; `validation_failed` — it is not the " +
            "schema's object (a missing or empty `integration_package_id` or `name`, a " +
            "`connection_id` that is not a uuid, `arguments` that is not an object, an unknown " +
            "field such as the retired `integration_id`); `connection_not_in_org_default` — an " +
            "enforced org default governs the integration and `connection_id` names a connection " +
            "outside its set (a holder of `credential-proxy:call`).",
          content: problemContent,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "`forbidden` — the principal holds neither `credential-proxy:call-own` nor " +
            "`credential-proxy:call`, or authenticates with a session cookie or another credential " +
            "the bearer-only proxy refuses (the chat's MCP loopback bearer included); " +
            "`credential_proxy_closed` — the space's `credential_proxy_open` is `false`, whatever " +
            "the caller's role; `call_permission_required` — an enforced org default governs the " +
            "integration and the caller holds `credential-proxy:call-own` without " +
            "`credential-proxy:call` (`Proxy-Status` error `http_request_denied`); the proxy's " +
            "refusals of the server URL, before anything is sent: `unauthorized_target` " +
            "(`http_request_denied`), `blocked_target` (`destination_ip_prohibited`), " +
            "`credential_exfiltration_refused` (`http_request_denied`).",
          headers: PROXY_STATUS_HEADER,
          content: problemContent,
        },
        "404": {
          description:
            "`not_found` — the integration is not active in this space, has no published version, " +
            "or its catalog offers no tool of that `name` (hidden, the connect tool, an " +
            "`api_call` tool, or undeclared while `allow_undeclared_tools` is not `true`), " +
            "before any exchange; `credential_not_found` — no connection the caller reaches, or " +
            "`connection_id` names nothing the caller reaches (the same body whether it is " +
            "another member's connection out of reach or no connection at all).",
          content: problemContent,
        },
        "409": {
          description:
            "The connection selection of `/api/credential-proxy/proxy` refused, judged for the " +
            "named tool: `must_choose_connection` (`errors[0].candidate_connections`, each " +
            "with its `missing_scopes` for the tool; retry with one `id` in `connection_id`), " +
            "`needs_reconnection`, `pinned_connection_unavailable`; `insufficient_scopes` — the " +
            "connection lacks scopes the tool's `tools_policy` entry requires " +
            "(`errors[0].missing_scopes`, `required_scopes`, `auth_key`, `connection_id`, " +
            "`owned_by_actor`, `remedy`). With `X-Appstrate-Connect-Offers: 1` and " +
            "`integrations:connect`, an item a connect flow clears carries a `connect_url` (a " +
            "reconnection of the caller's own connection; never `insufficient_scopes`, whose " +
            "`remedy` says what to do).",
          content: problemContent,
        },
        "422": {
          description:
            "`integration_not_remote` — the integration is not backed by a Streamable HTTP MCP " +
            "server; `remote_url_unrenderable` — its server URL is built from the connection's " +
            "variables and they do not render it.",
          content: problemContent,
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "502": {
          description:
            "`bad_gateway` — the MCP server failed the exchange, or refused the connection's " +
            "credential (HTTP 401 or 403); `upstream_mcp_error` — it answered a JSON-RPC error " +
            "(`mcp_error: { code, message }`, its message untrusted text); " +
            "`upstream_response_too_large` — the tool ran, but its answer exceeds the exchange " +
            "bound; the proxy's own `upstream_unresolvable` (`Proxy-Status` error `dns_error`), " +
            "`upstream_unreachable` (`destination_unavailable`) and `credential_unusable` " +
            "(`proxy_configuration_error`).",
          headers: PROXY_STATUS_HEADER,
          content: problemContent,
        },
        "503": {
          description:
            "`encryption_key_unavailable` — the connection's stored credential is encrypted under " +
            "a key id missing from the platform's keyring; nothing was sent (`Proxy-Status` error " +
            "`proxy_configuration_error`).",
          headers: PROXY_STATUS_HEADER,
          content: problemContent,
        },
        "504": {
          description:
            "`upstream_timeout` — the MCP server did not answer within the call's deadline " +
            "(`Proxy-Status` error `http_response_timeout`).",
          headers: PROXY_STATUS_HEADER,
          content: problemContent,
        },
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
