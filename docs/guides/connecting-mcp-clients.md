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
  read-only helpers `read_file`, `validate_package_file`,
  `get_runtime_capabilities` and `get_me`.
- `mcp:invoke` — `invoke_operation` (call an operation). Defence in depth: the
  dispatched operation still enforces its own permission, so an MCP call can
  never exceed what the key could do over REST.

Grant the key the permissions the work needs on top of those two: what the
server declares follows the key's scopes (see "The tool surface"). Calling a
third-party API through one of your connections takes `credential-proxy:call-own`
(your own connections) or `credential-proxy:call` (every connection usable in the
space, which implies `call-own`). A key carries either only from a creator who
holds it (`call` for a space `admin` or `builder`, `call-own` for an `operator`,
or a custom role that lists it).

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
> another space. `credential_proxy_closed` is final in the same way: the space
> named by `space` closes `search_integration_tools` and `call_integration_tool`
> to every role. Only
> an unknown tool name is a JSON-RPC `-32602`.
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
>
> Appstrate's own clients use the organization's URL: the claude.ai connector,
> and the Claude Code plugin installed by `appstrate code sync`. A plugin
> command that launches an agent names its space; a free-form request names
> none, so the model takes `space_id` from it or asks. The CLI's pinned space
> (`appstrate space switch`) is the default of its REST commands only.

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

## Agent prompts

The server declares the MCP `prompts` capability: `prompts/list` returns one
prompt per agent you can launch, in every space of the connection where you
hold what `run_and_wait` needs there (the same agents as `GET /api/agents` in
that space). A delegated credential is held to its scopes, as for the tools. A
pinned connection (`/api/mcp/o/<orgId>/s/<spaceId>`) lists the agents of its
space alone.

- **Name.** `run-<name>`. When the same agent is also launchable in another
  space, the later space's prompt is `run-<space name>-<name>`; another agent
  with the same name is `run-<scope>-<name>`; both continue with `-2`, `-3`, …
  Spaces are taken in the order of `GET /api/spaces`, agents by package id.
- **Argument.** One optional string, `request`: what you want, in your own
  words. The model builds the run's `input` from it against the agent's schema,
  and asks only for a missing required field.
- **Text.** `prompts/get` returns one `user` message: the steps to launch the
  agent at its latest published version with this server's `run_and_wait`
  (in the agent's space, `space_id`), to follow a run still going with
  `getRun`, to upload a file input, and to handle warnings and errors, followed
  by the agent's input contract (its JSON Schema and which fields are prompted,
  prefilled or locked; never a stored value) and the request. An agent with no
  published version has no prompt.
- **Errors.** A name `prompts/list` would not return you — unknown, in a space
  you cannot launch from, or unpublished — is answered `-32602`
  `Invalid prompt name`, the same for each.

A prompt is user-controlled: clients expose it as a command (Claude Code as
`/mcp__<server>__<prompt>`) and the model cannot invoke it on its own, so
choosing the command is the user asking for the metered run. The launch itself
is still a `run_and_wait` call, which your client may ask you to approve.

## Skills

The server declares the MCP Skills extension (`io.modelcontextprotocol/skills`,
SEP-2640) in `capabilities.extensions` of its `initialize` result, together with
the `resources` capability. Results carry no cache attributes.

- **`skills/list`** returns the published definition of every skill you may
  read in the spaces the connection reaches (the space of a space URL, every
  space of an organization URL), each skill under its own space's permissions:
  `skills:read` in that space (a delegated credential is held to its scopes),
  or, on the chat's own connection, a skill the current turn injected. No
  pagination. With the request `_meta` `{"dev.appstrate/definition": "draft"}`,
  it returns the drafts you may read instead, at their `@draft` URIs, each
  entry carrying `_meta["dev.appstrate/lock_version"]`: the package
  `lock_version` its files were read at.
- **Entry.** `uri` names the skill's `SKILL.md`; `frontmatter` is that file's
  YAML frontmatter, verbatim; `resources` lists every file of the skill with its
  `uri`, `digest` (`sha256:<hex>` of the bytes `resources/read` returns) and
  `size` in bytes.
- **URIs.** `skill://<spaceId>/<scope>/<package-name>/<name>/<path>` for the
  published definition, where `<scope>` drops the `@` and `<name>` is the
  frontmatter `name` of the served `SKILL.md`. A draft lives at
  `skill://<spaceId>/<scope>/<package-name>@draft/<name>/SKILL.md`: whoever
  may write the package reads it through `skills/get` and `resources/read`, and
  `skills/list` lists it only with the `dev.appstrate/definition` request
  `_meta` above.
- **Served files.** The skill is an Agent Skills directory: the package
  manifest and signature record are dropped, and the `name` line of `SKILL.md`
  is set to the served name when the stored one is not a valid Agent Skills
  name (1-64 characters of `[a-z0-9-]`, else derived from the package name).
  The frontmatter `metadata.version` holds the package version: the semver of
  a published definition; a draft has none. A file is returned whole, as `text` when its bytes are UTF-8, else as `blob`.
- **Limits.** A skill is served whole or not at all: one with more than 512
  files or more than 16 MiB of served bytes in total (the extension's limits,
  counted after `SKILL.md` normalization) is absent from `skills/list`, refused
  by `skills/get` and `resources/read`, and logged (`mcp.skill_unservable`).
  Within that total, a file of any size is served.
- **Errors.** `skills/get` answers `-32602` for a URI that names no skill you
  may read; `resources/read` answers `-32002` for a `skill://` URI that names no
  file you may read.
- **A skill the chat turn injected.** Outside `skills:read`, the chat turn's
  own bearer reads a skill its prompt injected, at the definition injected (a
  draft only at the `lock_version` injected, else `-32600` with
  `data.code: "injected_draft_changed"`), in the turn's space and while the
  caller holds `chat:write` there — even if the skill is switched off or
  `skills:read` is withdrawn mid-turn, since its `SKILL.md` is already in
  context.
- **REST.** `appstrate code sync` reads the same entries and bytes through the
  package API, for the space `X-Space-Id` names and behind `skills:read` there:
  `GET /api/packages/skills/served` (the entries of `skills/list`; with
  `?definition=draft`, the drafts you may read, at their `@draft` URIs) and
  `GET /api/packages/skills/served/archive?uri=` (a ZIP of every file
  `resources/read` serves for the skill whose `SKILL.md` is at `uri`).

## The tool surface

The server exposes a handful of tools rather than one per REST operation (which
would blow past any client's tool budget): the progressive-disclosure triple
over the API's operations, plus shortcuts for the things clients otherwise get
wrong and two tools for calling third-party APIs through your connections.
`mcp:read` is the transport gate — every row asking for it alone is shown to
anyone who can connect. The rows asking for more are **shown only when those
grants hold**. The server reads those grants off the guards mounted on the
operation each tool dispatches to (for `import_package_file`, the
`importBundle` route it stands in for); the permissions below are what those
guards require today. The package `:write` permissions are `agents:write`,
`skills:write`, `integrations:write` and `mcp-servers:write` — any one will do.

| Tool                       | Permission                                                            | What it does                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_me`                   | `mcp:read`                                                            | Caller identity, org role, and already-connected integrations. **Call this first** — it grounds everything below. Dropped for a client that injects its own caller context.                                       |
| `search_operations`        | `mcp:read`                                                            | Find operations by keyword/tag → operationIds. A keyword search also returns `best_match` with its full input schema.                                                                                             |
| `describe_operation`       | `mcp:read`                                                            | Full input schema for one operation (only needed when `best_match` didn't cover it).                                                                                                                              |
| `read_file`                | `mcp:read`                                                            | Read one `appfile://` URI; the file's own ACL decides on the row.                                                                                                                                                 |
| `validate_package_file`    | `mcp:read`                                                            | Check an `.afps`/ZIP archive before importing it.                                                                                                                                                                 |
| `get_runtime_capabilities` | `mcp:read`                                                            | The MCP-server runtimes and manifest templates package authoring works from.                                                                                                                                      |
| `invoke_operation`         | `mcp:invoke`                                                          | Execute one operation (validated + authorized exactly as the equivalent REST call).                                                                                                                               |
| `run_and_wait`             | `mcp:invoke` + `agents:run` + `runs:read` or `runs:read-all`          | **Launch and wait.** Starts an agent run (`kind:"agent"`) or an inline run (`kind:"inline"`) and waits for its outcome (see below).                                                                               |
| `list_files`               | `files:read`                                                          | List files visible to the caller (uploads + agent outputs), each with an `appfile://` URI.                                                                                                                        |
| `import_package_file`      | `mcp:invoke` + a package `:write` permission; not end-users           | Import a validated archive as a package.                                                                                                                                                                          |
| `search_integration_tools` | `mcp:invoke` + `credential-proxy:call-own` or `credential-proxy:call` | The tools of the integrations you hold a connection of, each with the connections it reaches; `best_match` carries an input schema and usage (see below). Absent in a space that closes direct connection access. |
| `call_integration_tool`    | `mcp:invoke` + `credential-proxy:call-own` or `credential-proxy:call` | Call one of those tools by name: `{ns}__api_call` calls a third-party API with a connection's credential injected by the platform (see below). Absent in a space that closes direct connection access.            |

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

How long it waits is its `wait` argument, in seconds, counted from the start of
the call (launch included): 50 when omitted, at most 1800 (a larger value is
clamped to it), and `0` returns right after the launch. The default fits under
the shortest per-call timeout MCP clients commonly apply (60 s); set `wait`
only when your client is known to keep a tool call open longer. When the run
ends within the wait, the call returns `done:true` with its outcome. Otherwise
it returns `done:false` with the run `id` and no outcome, and a second text
block saying what to do next: continue with `getRun` (`query: { wait: true }`,
which the server holds for at most 55 s) on that id, never with a second
`run_and_wait`. A wait longer than 55 s is a chain of such reads inside the one
call. `run_and_wait` takes `wait` as a non-negative integer number of seconds
and refuses any other value. The `wait` query of `getRun` also accepts `true`
(its 55 s ceiling) and `false` (no wait), clamps integer seconds to 55, and
does not wait when omitted.

A request carrying `params._meta.progressToken` is answered over SSE: during
the wait the call streams `notifications/progress` every 15 s. The same stream
relays the run's log lines as they are written: each `info`, `warn` or `error`
line becomes a notification whose `message` is `Run <id> [<level>] <message>`,
on one line and cut to 200 characters, without the line's `data`. At most one
log line is sent per second; when several arrive within that second, only the
latest is sent, and a line still held when the wait ends is sent just before
the result. Log lines and heartbeats share one strictly increasing `progress`
counter. They follow the caller's run read: a caller receives the lines of a
run it may read, as on `GET /api/realtime/runs/{id}`, never `debug` lines.
Most clients show these notifications to the user, not to the model. Progress
resets the timeout of a client that resets it on progress (the MCP TypeScript
SDK does so only with `resetTimeoutOnProgress: true`, default `false`); it
does not extend a fixed per-call timeout. A client that gives up on a call
without closing its HTTP connection (MCP SDK clients: their per-call timeout
only sends `notifications/cancelled` in a new POST, which a stateless server
cannot match to the call) leaves the server waiting until the wait ends; the
run itself is unaffected, so read it back with `getRun` rather than launching
it again. The MCP tasks extension (`io.modelcontextprotocol/tasks`), which
would let a client poll a long call natively, is the future target for long
runs; Appstrate does not implement it yet.

`search_integration_tools` and `call_integration_tool` are the credential proxy
(`/api/credential-proxy/*`) outside a run. The proxy route is not an operation
of the catalog, so `invoke_operation` does not reach it: these two tools are the
MCP path, and each request re-enters the route with your credential, so its
permission check, rate limit and call journal apply as over REST. They are
declared to a caller authenticated by a bearer (an API key or an OAuth token)
who holds `mcp:invoke` and `credential-proxy:call-own` or `credential-proxy:call`;
who holds each is stated in `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §3.4.
In a space whose admin turned off direct connection access
(`credential_proxy_open: false`, `PATCH /api/spaces/{id}`), neither tool is
declared for that space, whatever your role, and the REST route answers
`403 credential_proxy_closed`. On the organization URL, `space_id` naming such a
space is refused with `credential_proxy_closed`, which names the space and no
role. Runs keep their connections there:
`run_and_wait` can still have an agent make the call inside a run.

- **What you reach.** With `credential-proxy:call-own` alone, your OWN
  connections usable in the space, never one another member shared: that one,
  and every connection of an integration under an enforced organization default
  (`call_permission_required` in the listing), is reached by an agent run (`run_and_wait`).
  With `credential-proxy:call`, the connections usable in the space,
  yours and those another member shared into it, under the space's
  organization defaults. A shared connection is used when you name it
  (`connection_id`) or an organization default designates it, and under an
  enforced default only the connections it holds are reachable.
- **Discovery.** `search_integration_tools` takes an optional `query`, an
  optional `integration` (`@scope/name`) and a `limit`; with neither `query`
  nor `integration` it lists every tool you can call. A tool is named as in a
  run: `{ns}__api_call`, or `{ns}__api_call__{auth}` when several auths of the
  integration expose it, `{ns}` being the package id in snake case (`_2`, `_3`…
  when two packages share it). An integration lists the `api_call` tools its
  catalog exposes (every tool, less `hidden_tools` and its connect tools; not
  its `default_tools`, which only matter to an agent) whose auth has a
  connection you reach. Each result carries `tool`, `integration`,
  `description` and `connections`; with `query` or `integration`, `best_match`
  adds the first result's `input_schema` and `usage` (how to call the tool and
  read its result), so a search by a tool's exact name stands for a describe
  call, which does not exist.
  `connections` lists what a call would accept: per connection, the
  `connection_id` to pass, `label`, `auth_key`, `scopes_granted`, `owned_by_actor`
  (`false` for another member's), the `authorized_uris` a target must match,
  `allow_all_uris`, `needs_reconnection` and `call_permission_required`. It never carries a credential value: an entry that
  depends on one reads `{$credential.<field>}`, and you target it by writing
  `{{<field>}}` at that place in `target` (`{{webhook_url}}` for an entry that
  is `{$credential.webhook_url}` alone, `https://{{host}}/v1/items` for
  `https://{$credential.host}/**`); the platform fills it in.
- **A call.** `call_integration_tool` takes the `tool` name and its
  `arguments`, validates them against that tool's `input_schema` and hands
  them to the tool, whose result it returns; what holds for one tool only is in
  that tool's `usage`. For `{ns}__api_call`, `arguments.requests` holds 1 to 50
  requests to its integration, each naming a `method` and a `target`, with
  optional `headers`, `body`, `substitute_body` and `connection_id` (one of the
  tool's `connections`: which one, when several are callable, or to use a
  shared one; required when the tool lists several and the integration also
  has connections of another auth). A batch therefore never mixes two
  integrations. The platform injects the credential: a
  header of your own platform request (`Authorization`, `Cookie`, …) or one of
  the proxy's control headers is refused in `headers`, and the whole call is
  refused before anything is sent when an argument is malformed. Requests run
  concurrently, three at a time and not in order, and each counts against the
  proxy's rate limit.
- **Typed tools of a remote MCP server.** An integration backed by a remote
  MCP server (`source.kind: "remote"`, Streamable HTTP) also lists the tools
  that server offers, named
  `{ns}__{tool}` as in a run: its catalog's selection (the `tools_policy` keys,
  or every tool the server lists when `allow_undeclared_tools` is `true`), less
  `hidden_tools` and its connect tool. Descriptions and input schemas come from
  the server's `tools/list`, read with the connection the proxy selects for
  you as for an `api_call` (when several qualify, the first of your connections
  it accepts), sanitised as in a run and cached for 5 minutes per connection
  and integration version; the cache is read only after that selection, so it
  never answers for a connection you do not reach. A server URL built from
  connection variables (`{$variable.…}`) is rendered from that connection's.
  A server that cannot be listed leaves the tool names
  alone, each marked `catalog_unreadable: true`. A call is one `tools/call`
  through the credential proxy (`POST /api/credential-proxy/tools/call`), on the
  connection named by the `connection_id` argument of `call_integration_tool`
  (one of the tool's `connections`) or, without it, the one the proxy selects
  as for an `api_call`; when several qualify, the refusal lists the candidate
  connections. A call is journaled as one call of
  that connection and counted once against the rate limit; it returns the
  server's own tool result (`isError: true` is the tool's failure), refused
  past 256 KiB. The server's tool annotations are not relayed:
  `call_integration_tool` stays annotated destructive and open-world.
- **A result.** A `{ns}__api_call` returns `{ session_id, results }`, one
  entry per request, in order. An
  entry with `status` is the upstream's own answer, whatever the status, with a
  few response headers and a text `body` cut at `max_response_bytes` (32 KiB by
  default) and marked `truncated`; a non-text body is replaced by its size. All
  bodies of one result share a 256 KiB budget. A 3xx whose `Location` is outside
  the connection's `authorized_uris` is returned as is, not followed (unless the
  request fills in a credential `{{field}}`): fetch that `Location` yourself
  right away, since such signed URLs expire fast (1 minute for GitHub Actions
  logs). An entry with `error`
  (`{ status, code, detail }`) is the platform's refusal of that request
  (`call_permission_required`, `credential_not_found`, `must_choose_connection`,
  `needs_reconnection`, `unauthorized_target`, `rate_limited`, …) and does not
  stop the others. The result is `isError` only when no request succeeded.
- **Sessions.** Pass a previous result's `session_id` to keep the cookies the
  upstream set; omit it to start a session.

The `{ns}__api_call` of `call_integration_tool` and a run's `{ns}__api_call` share their name and role, not
their schema: a run has a workspace (`fromFile`, `responseMode.toFile`,
multipart bodies), a client outside one has none and pays for every round trip
(batches, `max_response_bytes`).

The exact argument and result schemas are the tools' own; the access rule is in
`docs/architecture/INTEGRATIONS_RUNTIME.md`, "AFPS Integrations — platform
credential proxy (`/api/credential-proxy/*`)".

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
`invoke_operation` — use `run_and_wait`, fetch logs, or poll instead. Nor can
the credential proxy: use `call_integration_tool`.
