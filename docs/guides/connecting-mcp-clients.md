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

Mint an API key in the dashboard (Settings → API keys) scoped to an application,
granting `mcp:read` and `mcp:invoke`. The key is already scoped to one
organization, so use that org's endpoint — no `X-Org-Id` header:

```sh
claude mcp add --transport http appstrate-<org> https://YOUR_INSTANCE/api/mcp/o/<orgId> \
  --header "Authorization: Bearer ask_xxx"
```

The `<orgId>` in the URL must be the key's own organization (the dashboard gives
you the matching command).

- `mcp:read` — connect, `search_operations`, `describe_operation`.
- `mcp:invoke` — `invoke_operation` (call an operation). Defence in depth: the
  dispatched operation still enforces its own permission, so an MCP call can
  never exceed what the key could do over REST.

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
   `/.well-known/oauth-protected-resource/api/mcp/o/<orgId>`, which points at
   this instance's authorization server and advertises the per-org resource URI.
3. The client identifies itself **without prior registration**, via one of:
   - **CIMD** (Client ID Metadata Documents, the MCP-spec-preferred default) —
     the client's `client_id` is an HTTPS URL the AS fetches and validates. The
     AS metadata advertises `client_id_metadata_document_supported: true`.
   - **DCR** (RFC 7591 Dynamic Client Registration) — the fallback for clients
     that can't host a metadata document. Self-service registration is bounded
     to identity + MCP scopes and rate-limited.
4. The user logs in and consents in the browser; the client receives an access
   token **audience-bound** to `https://YOUR_INSTANCE/api/mcp/o/<orgId>`
   (RFC 8707). The MCP server rejects any token not issued for this org's
   endpoint, and the token is rejected on every OTHER platform route (and every
   other org's MCP endpoint) — it can only ever drive `/api/mcp/o/<orgId>` for
   the one org it was issued for.

> **Organization & application context.** The organization is fixed by the
> endpoint: the token is bound to the org in the URL, so an OAuth-onboarded
> client needs **no** `X-Org-Id` header and there is no org-switch tool. To use
> several organizations, add one MCP server entry per org (each runs its own
> OAuth flow and gets its own org-bound token); the entries can be connected at
> the same time. Within an org, calls run against that org's **default
> application**. A client that needs a different application sends an
> `X-Application-Id` header (it must belong to the org).

### Self-hosting requirements for Path B

- The instance must be reachable over **HTTPS** at the configured `APP_URL`
  (CIMD documents and redirect URIs must be HTTPS; loopback is allowed only for
  local development).
- `APP_URL` must match the public origin clients reach — each per-org resource
  URI (`<APP_URL>/api/mcp/o/<orgId>`) is derived from it and must equal what the
  org's PRM advertises, or audience binding will reject tokens.
- The `oidc` module must be enabled (it is in the default `MODULES`).

### Security notes

- **Audience binding (RFC 8707), both directions, per organization:** tokens are
  bound to one org's resource URI `<APP_URL>/api/mcp/o/<orgId>`. A token issued
  for a different resource — including another org's MCP endpoint — is rejected
  at `/api/mcp/o/<orgId>` with `401` (inbound); and an MCP token presented to any
  other platform route is also rejected with `401` (outbound confinement). An
  OAuth MCP client carries the connecting user's full authority but can exercise
  it **only** through the MCP surface of the one org it authenticated for — the
  token cannot be lifted and replayed against the rest of the REST API or against
  another organization. Self-service (CIMD/DCR) clients are additionally
  forbidden at the token endpoint from requesting any audience other than a
  protected resource, so they can never obtain a platform-wide token in the first
  place. Cookie- and API-key-authenticated callers carry no token audience and
  are unaffected by either check.
- **CIMD fetch is SSRF-protected:** private/link-local/cloud-metadata ranges are
  blocked, with a 5s timeout, a 5KB body cap, JSON-only responses, and no
  redirect following — plus the platform's own host denylist.
- **DCR is bounded:** self-registered clients may request only identity + MCP
  scopes (never core action scopes), PKCE is required, and the registration
  endpoint is rate-limited per IP. The browser consent screen and the user's own
  permissions remain the real authorization gate.

---

## The tool surface

The server exposes three progressive-disclosure tools rather than ~250
individual tools (which would blow past any client's tool budget):

| Tool                 | Permission   | What it does                                            |
| -------------------- | ------------ | ------------------------------------------------------- |
| `search_operations`  | `mcp:read`   | Find operations by keyword/tag → operationIds.          |
| `describe_operation` | `mcp:read`   | Full input schema for one operation.                    |
| `invoke_operation`   | `mcp:invoke` | Execute one operation (validated + authorized as REST). |

Streaming/SSE operations (live logs, realtime) cannot be called through
`invoke_operation` — fetch logs or poll instead.
