# Connecting MCP clients to Appstrate

Appstrate exposes its REST API as an inbound **Model Context Protocol** server
at `/api/mcp` (Streamable HTTP, stateless). A generic MCP client — Claude Code,
Claude Desktop, Cursor — can connect and drive the platform with the connecting
identity's own permissions. The server never exposes a tool a REST caller with
the same credentials could not call: every invocation re-enters the platform's
auth pipeline + RBAC in-process.

There are two ways to connect: an **API key** in a header (works today, no
browser) and **browser OAuth** (CIMD / DCR, zero manual client registration).

> Endpoint: `https://YOUR_INSTANCE/api/mcp` — POST only (the stateless
> transport serves no GET SSE stream). Requires the `mcp:read` permission to
> connect and `mcp:invoke` to call operations.

---

## Path A — API key (no browser)

Mint an API key in the dashboard (Settings → API keys) scoped to an application,
granting `mcp:read` and `mcp:invoke`. Then:

```sh
claude mcp add --transport http appstrate https://YOUR_INSTANCE/api/mcp \
  --header "Authorization: Bearer ask_xxx" \
  --header "X-Org-Id: org_xxx"
```

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
claude mcp add --transport http appstrate https://YOUR_INSTANCE/api/mcp
# then: /mcp  →  Authenticate
```

What happens under the hood:

1. The tokenless request to `/api/mcp` returns `401` with
   `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:read mcp:invoke"`
   (RFC 9728 §5.1).
2. The client fetches the Protected Resource Metadata at
   `/.well-known/oauth-protected-resource/api/mcp`, which points at this
   instance's authorization server.
3. The client identifies itself **without prior registration**, via one of:
   - **CIMD** (Client ID Metadata Documents, the MCP-spec-preferred default) —
     the client's `client_id` is an HTTPS URL the AS fetches and validates. The
     AS metadata advertises `client_id_metadata_document_supported: true`.
   - **DCR** (RFC 7591 Dynamic Client Registration) — the fallback for clients
     that can't host a metadata document. Self-service registration is bounded
     to identity + MCP scopes and rate-limited.
4. The user logs in and consents in the browser; the client receives an access
   token **audience-bound** to `https://YOUR_INSTANCE/api/mcp` (RFC 8707). The
   MCP server rejects any token not issued for it, and the token is rejected on
   every OTHER platform route — it can only ever drive `/api/mcp`.

> **Organization context.** An OAuth-onboarded client acts as the connecting
> user, who may belong to several organizations. Send the target org with an
> `X-Org-Id: org_xxx` header (same as the API-key path); without it the request
> has no organization to resolve permissions against. A client that supports
> custom headers (Claude Code: `--header`) can set it once at connect time.

### Self-hosting requirements for Path B

- The instance must be reachable over **HTTPS** at the configured `APP_URL`
  (CIMD documents and redirect URIs must be HTTPS; loopback is allowed only for
  local development).
- `APP_URL` must match the public origin clients reach — the canonical resource
  URI (`<APP_URL>/api/mcp`) is derived from it and must equal what the PRM
  advertises, or audience binding will reject tokens.
- The `oidc` module must be enabled (it is in the default `MODULES`).

### Security notes

- **Audience binding (RFC 8707), both directions:** tokens are bound to
  `<APP_URL>/api/mcp`. A token issued for a different resource is rejected at
  `/api/mcp` with `401` (inbound); and an `/api/mcp` token presented to any
  other platform route is also rejected with `401` (outbound confinement). An
  OAuth MCP client carries the connecting user's full authority but can exercise
  it **only** through the MCP surface — the token cannot be lifted and replayed
  against the rest of the REST API. Self-service (CIMD/DCR) clients are
  additionally forbidden at the token endpoint from requesting any audience
  other than a protected resource, so they can never obtain a platform-wide
  token in the first place. Cookie- and API-key-authenticated callers carry no
  token audience and are unaffected by either check.
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
