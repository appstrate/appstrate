# Connecting MCP clients to Appstrate

Appstrate exposes its REST API as an inbound **Model Context Protocol** server,
with **one endpoint per organization** at `/api/mcp/o/<orgId>` (Streamable HTTP,
stateless). A generic MCP client — Claude Code, Claude Desktop, Cursor — can
connect and drive the platform with the connecting identity's own permissions,
confined to that one organization. The server never exposes a tool a REST caller
with the same credentials could not call: every invocation re-enters the
platform's auth pipeline + RBAC in-process.

There are two ways to connect: an **API key** in a header (works today, no
browser) and **browser OAuth** (CIMD / DCR, zero manual client registration).

> Endpoint: `https://YOUR_INSTANCE/api/mcp/o/<orgId>` — POST only (the stateless
> transport serves no GET SSE stream), where `<orgId>` is the organization id.
> Requires the `mcp:read` permission to connect and `mcp:invoke` to call
> operations. Copy the exact per-org command from the dashboard — an org id is
> not something you type by hand.

> **One endpoint per organization.** The org is in the URL, so a token obtained
> for it is audience-bound to that org (RFC 8707) and confined to it. To work
> with several organizations, add several MCP server entries (one per org) —
> they can be connected at the same time. There is no runtime org switch, by
> design: least privilege per org, the same way Notion and Slack issue one OAuth
> grant per workspace.

---

## Path A — API key (no browser)

Mint an API key in the dashboard (Settings → API keys) scoped to a space,
granting `mcp:read` and `mcp:invoke`. The key is already scoped to one
organization, so use that org's endpoint — no `X-Org-Id` header:

```sh
claude mcp add --transport http appstrate-<org> https://YOUR_INSTANCE/api/mcp/o/<orgId> \
  --header "Authorization: Bearer apst_xxx"
```

The `<orgId>` in the URL must be the key's own organization (the dashboard gives
you the matching command).

- `mcp:read` — connect, `search_operations`, `describe_operation`, and the
  read-only helpers `read_file`, `read_skill`, `validate_package_file`,
  `get_runtime_capabilities` and `get_me`.
- `mcp:invoke` — `invoke_operation` (call an operation). Defence in depth: the
  dispatched operation still enforces its own permission, so an MCP call can
  never exceed what the key could do over REST.

Grant the key the permissions the work needs on top of those two: what the
server declares follows the key's scopes (see "The tool surface").

This is the recommended onboarding until you have HTTPS + the OAuth flow set up.

---

## Path B — Browser OAuth (zero-config)

A spec-compliant client (Claude Code, Claude Desktop, Cursor) discovers
everything it needs and runs a browser login — no key to paste, no client to
pre-register:

```sh
claude mcp add --transport http appstrate-<org> https://YOUR_INSTANCE/api/mcp/o/<orgId>
# then: /mcp  →  Authenticate
```

Copy the exact `claude mcp add --transport http appstrate-<org> https://YOUR_INSTANCE/api/mcp/o/<orgId>`
command for each organization from the dashboard.

What happens under the hood:

1. The tokenless request to `/api/mcp/o/<orgId>` returns `401` with
   `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:read mcp:invoke"`
   (RFC 9728 §5.1).
2. The client fetches the Protected Resource Metadata at
   `/.well-known/oauth-protected-resource/api/mcp/o/<orgId>` (or
   `…/s/<spc_…>` for a space's endpoint). It points at this instance's
   authorization server and advertises the endpoint's own URL as `resource`
   (RFC 9728 §3.3).
3. The client identifies itself **without prior registration**, via one of:
   - **CIMD** (Client ID Metadata Documents, the MCP-spec-preferred default) —
     the client's `client_id` is an HTTPS URL the AS fetches and validates. The
     AS metadata advertises `client_id_metadata_document_supported: true`.
   - **DCR** (RFC 7591 Dynamic Client Registration) — the fallback for clients
     that can't host a metadata document. Self-service registration is bounded
     to identity + MCP scopes and rate-limited.
4. The user logs in and consents in the browser; the client receives an access
   token **audience-bound** to the resource it asked for (RFC 8707): the org's
   endpoint, `https://YOUR_INSTANCE/api/mcp/o/<orgId>`, or one space's endpoint,
   `https://YOUR_INSTANCE/api/mcp/o/<orgId>/s/<spc_…>`. Each endpoint rejects
   any token not issued for it, and the token is rejected on every OTHER
   platform route (and every other org's MCP endpoint).

> **Organization & space context.** The organization is fixed by the
> endpoint: the token is bound to the org in the URL, so an OAuth-onboarded
> client needs **no** `X-Org-Id` header and there is no org-switch tool. To use
> several organizations, add one MCP server entry per org (each runs its own
> OAuth flow and gets its own org-bound token); the entries can be connected at
> the same time.
>
> Within an org, one connection reaches **every space you hold a role in**.
> Every tool that acts in a space requires a `space_id` argument, reads and
> writes alike: there is no default space. The argument's schema lists your
> spaces (name, `spc_…` id, your role there), since clients may truncate the
> server instructions. Space names are not unique, so every machine field names
> a space by its id: `granted_in` in results, and the bracketed ids in the
> operation index (`createAgent [spc_…]`). Names appear in prose only, such as
> `Available in: …` on a tool. A `resources/read` of an `appfile://` link needs
> no argument: the file's own space is used. A file you cannot reach is the
> JSON-RPC error `-32002` (resource not found), a malformed URI `-32602`.
>
> A refused tool call is a tool result with `isError: true` whose text is JSON
> `{ code, error, … }`, not a JSON-RPC error. `missing_argument`,
> `unknown_argument`, `invalid_argument`, `unknown_operation`, `unknown_space`
> and `space_mismatch` mean the call itself is wrong: `arguments` names the
> faulty arguments, `accepted` lists what is valid, and the call can be
> retried. `not_granted` is final: your role in the space named by `space` does
> not allow the action, `granted_in` lists the spaces where it does, and the
> result asks the model to report the refusal rather than redo the action in
> another space. Only an unknown tool name is a JSON-RPC `-32602`.
>
> A refusal is about the call itself. An operation the route answered with an
> HTTP error (an `invoke_operation` call, or a `run_and_wait` launch the route
> rejected) is an outcome, not a refusal: it comes back as `{ status, body }`
> with `isError: true`, and `body` is the route's own problem document. The one
> exception is an `invoke_operation` `403` that your permissions explain: it is
> a `not_granted` refusal that also carries `status` and `body`.
>
> To confine a client to one space, use the space's URL,
> `/api/mcp/o/<org>/s/<spc_…>`. It must name a space of the org where you hold
> a role: the connection is then pinned, `space_id` is not declared, and every
> call enters that space. An operation whose path names another space
> (`updateSpace`, member management) still reaches it when your role there
> allows it, exactly as over REST. The space's URL is its own OAuth resource.
> A token for it is accepted on that URL only: not on the organization's
> endpoint and not on another space's URL. A token for the organization is
> accepted on every space URL of that organization. A space-bound token also
> pins its space on the REST API, where a request naming another space is
> refused, as it is for a space API key. It is also capped like a space API
> key: an organization-level permission (member management, organization
> settings) is out of its reach whatever your organization role, so use the
> organization's URL for that work. The URL needs no other setup, and any
> client can use it, a header-less one (a claude.ai connector) included.
> Settings → General → "MCP connection" builds both URLs. The MCP endpoint
> reads no `X-Space-Id`: a request carrying one is a `400` naming the URL form.
> An API key is always pinned to its own space, and a URL naming another one is
> a `403`.

### Self-hosting requirements for Path B

- The instance must be reachable over **HTTPS** at the configured `APP_URL`
  (CIMD documents must be served over HTTPS; an instance on `http://localhost`
  is a development setup only). Client **redirect URIs** are a separate matter:
  `http://` is accepted for loopback hosts in every environment, on both the
  self-registration (DCR) and dashboard paths — RFC 8252 §7.3.
- `APP_URL` must match the public origin clients reach — each per-org resource
  URI (`<APP_URL>/api/mcp/o/<orgId>`) is derived from it and must equal what the
  org's PRM advertises, or audience binding will reject tokens.
- The `oidc` module must be enabled (it is in the default `MODULES`).

### Security notes

- **Audience binding (RFC 8707), both directions, per organization and per
  space:** a token is bound to one resource, either the org's
  `<APP_URL>/api/mcp/o/<orgId>` or a space's
  `<APP_URL>/api/mcp/o/<orgId>/s/<spc_…>`. The org endpoint accepts only the
  org's token; a space endpoint accepts its own space's token or its org's
  token. A token issued for any other resource (another org's endpoint, another
  space's endpoint) is rejected with `401` (inbound), and an MCP token presented
  to any other platform route is also rejected with `401` (outbound
  confinement). An OAuth MCP client carries the connecting user's full authority
  but can exercise it **only** through the MCP surface of the org, or the space,
  it authenticated for — the token cannot be lifted and replayed against the
  rest of the REST API or against another organization. Self-service (CIMD/DCR) clients are additionally
  forbidden at the token endpoint from requesting any audience other than a
  protected resource, so they can never obtain a platform-wide token in the first
  place. Cookie- and API-key-authenticated callers carry no token audience and
  are unaffected by either check.
- **CIMD fetch is SSRF-protected:** the document is fetched over HTTPS only,
  through a single DNS lookup whose every answer must be publicly routable, with
  the connection pinned to that address; no redirects are followed, the response
  must be JSON, and it is bounded by a 5s timeout and a 5KB body cap. The
  platform adds a literal host denylist on top, which also covers the run
  network's internal Docker aliases.
- **DCR is bounded:** self-registered clients may request only identity + MCP
  scopes (never core action scopes), PKCE is required, and the registration
  endpoint is rate-limited per IP. The browser consent screen and the user's own
  permissions remain the real authorization gate.

---

## The tool surface

The server exposes a handful of tools rather than one per REST operation (which
would blow past any client's tool budget): the progressive-disclosure triple
over the whole API, plus shortcuts for the things clients otherwise get wrong.
`mcp:read` is the transport gate — every row asking for it alone is shown to
anyone who can connect. The rows asking for more are **shown only when those
grants hold**. The server reads those grants off the guards mounted on the
operation each tool dispatches to (for `import_package_file`, the
`importBundle` route it stands in for); the permissions below are what those
guards require today. The package `:write` permissions are `agents:write`,
`skills:write`, `integrations:write` and `mcp-servers:write` — any one will do.

| Tool                       | Permission                                                   | What it does                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_me`                   | `mcp:read`                                                   | Caller identity, org role, and already-connected integrations. **Call this first** — it grounds everything below. Dropped for a client that injects its own caller context. |
| `search_operations`        | `mcp:read`                                                   | Find operations by keyword/tag → operationIds. A keyword search also returns `best_match` with its full input schema.                                                       |
| `describe_operation`       | `mcp:read`                                                   | Full input schema for one operation (only needed when `best_match` didn't cover it).                                                                                        |
| `read_file`                | `mcp:read`                                                   | Read one `appfile://` URI; the file's own ACL decides on the row.                                                                                                           |
| `read_skill`               | `mcp:read`                                                   | A skill's `SKILL.md` and files; `skills:read`, or a skill the chat turn injected (see below).                                                                               |
| `validate_package_file`    | `mcp:read`                                                   | Check an `.afps`/ZIP archive before importing it.                                                                                                                           |
| `get_runtime_capabilities` | `mcp:read`                                                   | The MCP-server runtimes and manifest templates package authoring works from.                                                                                                |
| `invoke_operation`         | `mcp:invoke`                                                 | Execute one operation (validated + authorized exactly as the equivalent REST call).                                                                                         |
| `run_and_wait`             | `mcp:invoke` + `agents:run` + `runs:read` or `runs:read-all` | **Launch and wait.** Starts an agent run (`kind:"agent"`) or an inline run (`kind:"inline"`) and waits for its outcome (see below).                                         |
| `list_files`               | `files:read`                                                 | List files visible to the caller (uploads + agent outputs), each with an `appfile://` URI.                                                                                  |
| `import_package_file`      | `mcp:invoke` + a package `:write` permission; not end-users  | Import a validated archive as a package.                                                                                                                                    |

`read_skill` needs `skills:read`, except for a skill a chat turn injected:
that turn's own bearer reads it at the definition injected (a draft only at the
`lock_version` injected, else 409 `injected_draft_changed`), in the turn's
space and while the caller holds `chat:write` there — even if the skill is
switched off or `skills:read` is withdrawn mid-turn, since its `SKILL.md` is
already in context.

`run_and_wait` needs both halves because it launches AND polls the run back
under your own credentials: `agents:run` without a run-read permission would
bill a run you could never read. It declares the inline kind and its arguments
(`manifest`, `prompt`, `context_files`) only to a caller who also holds
`agents:write`; anyone else is offered `kind:"agent"` alone.

Its `structuredContent` follows the tool's declared `outputSchema` (the
`RunAndWaitResult` component of the OpenAPI spec), and the server refuses to
answer anything else: `{ id, packageId, status, done, warnings }`, plus
`result`, `error` and `files` once the run is over. `done` is the only thing
that tells a finished run from one still going; `error` is always the run's own
failure, and `warnings` is `[]` when the launch reported none.

How long it waits depends on the client. Both delays derive from the MCP SDK
client's default request timeout (60 s). A request carrying
`params._meta.progressToken` is answered over SSE: the call streams
`notifications/progress` every 15 s (a quarter of it) and returns `done:true`
once the run is over. Without a token nothing can keep the request alive, so
after 45 s (one heartbeat short of it) it returns `done:false` with the run
`id` and no outcome, and a second text block saying what to do next: continue
with `getRun` (`query: { wait: true }`, which the server holds for at most
55 s) on that id, never with a second `run_and_wait`.
Progress only helps a client that resets its request timeout on it: the MCP
TypeScript SDK does so only with `resetTimeoutOnProgress: true` (default
`false`). A client that sends a token without resetting its timeout on progress
hits its own timeout on a long run, not the `done:false` fallback: the server
cannot tell it apart from one that does. A client that gives up on a streamed
call without closing its HTTP connection (MCP SDK clients: their per-call
timeout only sends `notifications/cancelled` in a new POST, which a stateless
server cannot match to the call) leaves the server waiting until the run ends,
30 min at most; the run itself is unaffected, so read it back with `getRun`
rather than launching it again.

The whole surface follows your permissions the same way: the tool list, the
operation index in the server instructions, `search_operations` (matches you
cannot invoke come back under `denied` with their `required_permissions`, never
mixed into `operations`) and
`describe_operation` (`granted`, `required_permissions`,
`target_space_permissions`, `ceiling_permissions`). What your role makes impossible is
**not shown** rather than shown and refused — but an operation your permission
set alone cannot decide stays listed: either the loaded row decides it (a file
ACL, a draft's home space), or a guard on it is enforced in the space the path
names rather than the one you are calling from. A row decision is not announced
in advance; the route's own refusal names it.
The two are separate fields: `required_permissions` carries the guards read in
the space you are calling from — the only ones filtering tests — and
`target_space_permissions` carries those enforced in the space the path names,
shown so you can see them and never used to filter. `ceiling_permissions`
carries the scopes a delegated credential (API key, OAuth token) must include
for an operation authorized by ownership rather than a role, such as deleting
your own connection. A session is never filtered on them; a delegated credential
whose scopes omit one sees the operation as not granted, and its
`search_operations` `denied[]` entry and `403` answer name them as
`ceiling_permissions`. Otherwise `denied[].required_permissions` and the `not_granted`
hint below carry the caller-space half alone. Enforcement itself never moves: `invoke_operation` always
dispatches. A `403` attributable to a permission
missing from your own space comes back as a `not_granted` refusal (see above)
with `required_permissions` and a hint to report it rather than retry; a
refusal decided by the row, or by the space the path names, is the route's own
`403`, returned as `status` and `body` of the tool result.

This server advertises `tools: { listChanged: false }`, so a client that listed
its tools before an upgrade — or before its role changed — is never told the set
moved, and a name that is no longer registered answers the JSON-RPC error
`-32602 Unknown tool`.
**Re-list your tools after upgrading the platform or changing your
permissions** — that is the supported recovery, and it is one round trip.

Prefer `run_and_wait` when you need a newly launched run's progress or terminal
result. `runAgent` (and `runInline`, for a caller holding `agents:write` and
`agents:run`) remain fully discoverable and invokable for
intentional fire-and-forget flows (`201` with the created run resource). Calling either and then
polling `getRun` merely reimplements what `run_and_wait` already does, without
its in-chat progress surface or `resource_link` deliverables.

For `kind:"inline"`, `manifest` is a partial canonical AFPS manifest. A normal
call can provide only a task-specific `display_name` plus its dependencies and
integration configuration; `run_and_wait` derives `name` and defaults the
omitted AFPS boilerplate, `runtime_tools` (`log`, `output`,
`publish_file`), and an open object output schema. Defaults fill absent top-level
fields only. Every supplied field is preserved as an exact
replacement—arrays and nested objects are not merged, and
`runtime_tools: []` remains empty. Clients can therefore provide a complete
deterministic manifest and override every field, including a strict
`output.schema` (which requires `output` in an explicitly overridden
`runtime_tools`).

Streaming/SSE operations (live logs, realtime) cannot be called through
`invoke_operation` — use `run_and_wait`, fetch logs, or poll instead.
