# Writing an integration with `connect`

How an AFPS integration author declares **credential acquisition and delivery** in
`manifest.auths.{key}`. A single declarative substrate covers every shape — the platform
selects a strategy purely from the manifest. This guide maps each declaration to the
strategy it selects, shows the minimal manifest for each, and covers the surrounding
v2 model (sources, delivery vocabulary, per-tool policy, scope catalog).

> Spec: [`afps-spec/spec.md`](../../../afps-spec/spec.md) §3.5 + §7.1–§7.10.
> Canonical examples: [`afps-spec/examples/integration-oauth2`](../../../afps-spec/examples/integration-oauth2/manifest.json),
> [`integration-apikey`](../../../afps-spec/examples/integration-apikey/manifest.json),
> [`integration-basic`](../../../afps-spec/examples/integration-basic/manifest.json).
> Schema reference: `@afps-spec/schema` (`integrationManifestSchema`, `connectSchema`,
> `deliverySchema`, `authMethod`).
> Platform source of truth: `apps/api/src/services/connect/registry.ts` (`resolveStrategy`).

All manifest field names below are **snake_case** — the AFPS wire convention.
All value templates use the Arazzo runtime-expression grammar `{$credential.<field>}`,
`{$outputs.<name>}` — NOT the 1.x `{{<field>}}` form.

```jsonc
{
  "$schema": "https://schemas.afps.dev/v0/integration.schema.json",
  "schema_version": "0.1",
  "type": "integration",
  // …
}
```

## Strategy selection at a glance

| `auth.type` | `connect` | `connect.tool` `run_at` | Strategy     | Flow                                                |
| ----------- | --------- | ----------------------- | ------------ | --------------------------------------------------- |
| `oauth2`    | —         | —                       | OAuth2       | OAuth 2.0 + PKCE, discovery + auto-refresh          |
| `api_key`   | —         | —                       | Fields       | paste-the-bag (user submits the credential)         |
| `basic`     | —         | —                       | Fields       | paste-the-bag (username + password)                 |
| `mtls`      | —         | —                       | Fields       | paste-the-bag (client cert + key, mounted as files) |
| `custom`    | _absent_  | —                       | Fields       | paste-the-bag, free-form `credentials.schema`       |
| `custom`    | `login`   | —                       | Login        | one declarative HTTP login request                  |
| `custom`    | `tool`    | `run-start`             | LoginSecret  | store the secret, mint the session at each run      |
| `custom`    | `tool`    | `link`                  | Orchestrated | run the login tool once in an ephemeral connect-run |

AFPS auth `type` is one of `oauth2 | api_key | basic | mtls | custom`. The 1.x
`oauth1` type is **removed** — no working connect path, no signing layer was ever
implemented. Model OAuth1 services as `custom` plus an orchestrated `connect.tool` if
needed.

---

## `source` — the capability surface

Every integration declares `source.kind` to tell the platform how the upstream is
reached. The authentication layer (`auths`) is applied on top, regardless of source.

| `source.kind` | Sub-object                                                                         | When to use                                                                                   |
| ------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `local`       | `source.server: { name, version, vendored? }` — references an `mcp-server` package | Local stdio MCP server (Node, Python, binary) bundled separately                              |
| `remote`      | `source.remote: { url, transport: "streamable-http" \| "sse" }`                    | Hosted MCP endpoint (Google MCP, Anthropic-hosted MCPs, Composio, Linear, …)                  |
| `none`        | _(no sub-object)_                                                                  | Serverless integration — no MCP server; reaches upstream via the `api_call` vendor capability |

```jsonc
// local — references a separate mcp-server package by AFPS identity + semver range
"source": { "kind": "local", "server": { "name": "@example/gmail-server", "version": "^1.2.0" } }

// remote — hosted MCP endpoint
"source": { "kind": "remote", "remote": { "url": "https://gmailmcp.googleapis.com/mcp/v1", "transport": "streamable-http" } }

// none — serverless: no MCP server
"source": { "kind": "none" }
```

### Enabling `api_call`

`api_call` is an Appstrate vendor capability **orthogonal** to `source.kind` — any
integration (`local`, `remote`, or `none`) can expose it by opting `auths` entries into
the `_meta["dev.appstrate/api"]` extension. Each opted-in auth key (must exist in the
top-level `auths`) yields one `api_call` tool; a single opted-in auth → `api_call`,
multiple → `api_call__<authKey>`.

```jsonc
"_meta": {
  "dev.appstrate/api": {
    "auths": {
      "primary": { "upload_protocols": ["google-resumable", "tus"] }
    }
  }
}
```

`upload_protocols` is an optional per-auth **open** array of strings (reserved values:
`google-resumable`, `s3-multipart`, `tus`, `ms-resumable`). Producers MAY emit other
identifiers (prefer reverse-DNS qualified strings such as
`com.example/proprietary-resumable`); consumers MUST preserve unknown values.

Declaring it also adds an `api_upload` companion tool to the integration's
`tool_catalog` (`api_upload__<authKey>` in the multi-auth case) — a chunked/resumable
uploader for workspace files, orchestrated agent-side and dispatched through the
sibling `api_call` tool. Agents get the pair from either name: selecting `api_call`
grants `api_upload` and vice-versa. Hide the companion with
`hidden_tools: ["api_upload"]` if the API's upload surface shouldn't be agent-facing.

---

## `delivery` — where the credential is injected

Every auth method MUST declare a `delivery` block (§7.6). Three injection modes are
defined; an auth method MUST NOT mix `http` with `env` / `files`.

| Mode    | Vocabulary                                                          | Maps to                                                  | Use when                                                                                      |
| ------- | ------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `http`  | `{ in, name, prefix?, value, encoding?, allow_server_override? }`   | OpenAPI Security Scheme location + AFPS `value` template | Server never sees the secret — sidecar injects it on outbound requests (MITM proxy injection) |
| `env`   | Map of `ENV_NAME → { value, sensitive?, user_config_key? }`         | Kubernetes-style + MCPB `user_config`                    | `source.kind: "local"` — the MCP server reads the credential from its own env                 |
| `files` | Map of `<path> → { value, mode? }` (octal string, default `"0400"`) | Kubernetes-style file mount                              | Tooling that reads a cert / key from disk (`mtls`, gcloud service-account JSON, …)            |

Value templates use the Arazzo runtime-expression grammar embedded as `{$expr}` —
e.g. `{$credential.access_token}`, `{$outputs.token}`. No Handlebars, no `{{name}}`.

```jsonc
// http — Bearer (OAuth2 / API key)
"delivery": {
  "http": {
    "in": "header",
    "name": "Authorization",
    "prefix": "Bearer ",
    "value": "{$credential.access_token}"
  }
}

// http — HTTP Basic vendor pattern (rendered then base64-encoded)
"delivery": {
  "http": {
    "in": "header",
    "name": "Authorization",
    "prefix": "Basic ",
    "value": "{$credential.username}:{$credential.password}",
    "encoding": "base64"
  }
}

// env — MCP server reads the secret from $GMAIL_TOKEN
"delivery": {
  "env": {
    "GMAIL_TOKEN": {
      "value": "{$credential.access_token}",
      "sensitive": true,
      "user_config_key": "GMAIL_TOKEN"
    }
  }
}

// files — mount a PEM blob at a fixed path
"delivery": {
  "files": {
    "/run/creds/client.crt": { "value": "{$credential.client_cert}", "mode": "0444" },
    "/run/creds/client.key": { "value": "{$credential.client_key}", "mode": "0400" }
  }
}
```

`allow_server_override` (default `false`) governs whether the source server may
override the injected header. Keep it `false` unless you have a reason — defence in
depth against an integration that accidentally pre-empts the injection.

---

## 1. OAuth 2.0 (`oauth2`)

For IdPs that support the authorization-code + PKCE flow. AFPS is
**discovery-first**: when `issuer` is present, the consumer probes the three
well-known locations (RFC 8414, OIDC path-insertion, OIDC path-append) and validates
that the returned `issuer` member matches before using any discovered endpoint.
Discovery is best-effort enrichment — every discovered field MUST be overridable, and
a fully-manual configuration MUST be supported.

```jsonc
"auths": {
  "oauth": {
    "type": "oauth2",
    "issuer": "https://accounts.example.com",            // enables RFC 8414 discovery
    "authorization_endpoint": "https://accounts.example.com/oauth/authorize",
    "token_endpoint": "https://accounts.example.com/oauth/token",
    "userinfo_endpoint": "https://accounts.example.com/oauth/userinfo",
    "token_endpoint_auth_method": "client_secret_basic", // default per RFC 8414 §2
    "code_challenge_methods_supported": ["S256"],
    "resource": "https://api.example.com",               // RFC 8707 — NOT 'audience'
    "authorization_params": { "access_type": "offline", "prompt": "consent" },
    "default_scopes": ["read"],
    "scope_catalog": [
      { "value": "read",  "label": "Read access" },
      { "value": "write", "label": "Write access" },
      { "value": "admin", "label": "Admin access", "implies": ["read", "write"] }
    ],
    "identity_claims": { "email": "email", "user_id": "sub" },
    "required_identity_claims": ["email"],
    "callback_url_hint": "Set the authorized redirect URI to: {{callback_url}}",
    "authorized_uris": ["https://api.example.com/**"],
    "delivery": {
      "http": {
        "in": "header",
        "name": "Authorization",
        "prefix": "Bearer ",
        "value": "{$credential.access_token}"
      }
    }
  }
}
```

Token refresh is automatic (proactive near expiry + on a mid-run `401`). Nothing else
to wire. Field names map verbatim to RFC 8414 / OIDC Discovery so a value from a
provider's `.well-known/openid-configuration` can be copy-pasted.

> Note: the field is `resource` (RFC 8707 — the protected-resource indicator), **not**
> `audience`. Send it for forward compatibility even when the AS is known to ignore
> it; the resource server validates the token audience independently.

### `scope_catalog` + `implies`

`scope_catalog` is the AFPS-authoritative scope list — `scopes_supported` from RFC 8414
is RECOMMENDED-only and frequently incomplete. Each entry: `{ value, label, description?, implies? }`.

`implies` is a directed graph: granting a "broader" scope automatically satisfies any
"narrower" scope requirement. Example:

```jsonc
"scope_catalog": [
  { "value": "read",  "label": "Read access" },
  { "value": "admin", "label": "Admin access", "implies": ["read"] }
]
```

An agent that declares `dependencies.integrations["@me/svc"].scopes: ["read"]` and a
connection granted only `["admin"]` is treated as satisfying the requirement — `admin`
implies `read`. Useful when an IdP exposes umbrella scopes that subsume finer ones.

The agent-install scope union is computed from `default_scopes ∪ per-agent scopes
∪ tools_policy[t].required_scopes` over the agent's selected tools. The platform's
incremental-consent flow re-requests the union when an installed agent grows.

---

## 2. Paste-the-bag (`api_key` / `basic` / `mtls` / bare `custom`)

The user submits the credential through the dashboard fields modal. The auth method
declares the shape via `credentials.schema` — a self-contained JSON Schema 2020-12
document (local-fragment `$ref` only, no external `$ref`).

### `api_key`

```jsonc
"auths": {
  "token": {
    "type": "api_key",
    "credentials": {
      "schema": {
        "type": "object",
        "required": ["api_key"],
        "properties": { "api_key": { "type": "string", "description": "Service API key" } }
      }
    },
    "delivery": {
      "http": {
        "in": "header",
        "name": "Authorization",
        "prefix": "Bearer ",
        "value": "{$credential.api_key}"
      }
    },
    "authorized_uris": ["https://api.example.com/**"]
  }
}
```

### `basic`

```jsonc
"auths": {
  "basic": {
    "type": "basic",
    "credentials": {
      "schema": {
        "type": "object",
        "required": ["username", "password"],
        "properties": {
          "username": { "type": "string" },
          "password": { "type": "string" }
        }
      }
    },
    "delivery": {
      "http": {
        "in": "header",
        "name": "Authorization",
        "prefix": "Basic ",
        "value": "{$credential.username}:{$credential.password}",
        "encoding": "base64"
      }
    },
    "authorized_uris": ["https://api.internal.example.com/**"]
  }
}
```

### `mtls`

Mutual TLS — the user supplies the client certificate and private key (PEM), and
they are mounted as files at a well-known path the HTTP client loads.

```jsonc
"auths": {
  "mtls": {
    "type": "mtls",
    "credentials": {
      "schema": {
        "type": "object",
        "required": ["client_cert", "client_key"],
        "properties": {
          "client_cert": { "type": "string", "description": "Client certificate (PEM)" },
          "client_key":  { "type": "string", "description": "Client private key (PEM)" },
          "ca_chain":    { "type": "string", "description": "Optional intermediate CA chain (PEM)" }
        }
      }
    },
    "delivery": {
      "files": {
        "/run/creds/client.crt":   { "value": "{$credential.client_cert}", "mode": "0444" },
        "/run/creds/client.key":   { "value": "{$credential.client_key}",  "mode": "0400" },
        "/run/creds/ca-chain.pem": { "value": "{$credential.ca_chain}",    "mode": "0444" }
      }
    },
    "authorized_uris": ["https://api.example.com/**"]
  }
}
```

The well-known path is integration-conventional — pick one that matches what the
source server expects. `mode` is an octal **string** (default `"0400"`); set the cert
to `"0444"` if it must be world-readable, keep the key at `"0400"`.

---

## 3. Declarative login (`custom` + `connect.login`)

For services where a **single** stateless HTTP request exchanges a user-supplied
secret (password, API token) for a session credential — no redirect chain, no
impersonation. Exactly one request. Extract the credential from the response with
Arazzo Selector Objects or the AFPS extractor extensions (`cookie`, `jwt`, `regex`).

```jsonc
"auths": {
  "session": {
    "type": "custom",
    "credentials": {
      "schema": {
        "type": "object",
        "required": ["email", "password"],
        "properties": {
          "email":    { "type": "string", "format": "email" },
          "password": { "type": "string" }
        }
      }
    },
    "connect": {
      "login": {
        "request": {
          "method": "POST",
          "url": "https://example.com/login",
          "content_type": "application/json",
          "body": "{\"email\":\"{$credential.email}\",\"password\":\"{$credential.password}\"}"
        },
        "success_criteria": [
          { "condition": "$statusCode == 200", "type": "simple" }
        ],
        "outputs": {
          "token": "$response.body#/access_token",
          "exp":   "$response.header.X-Expires-After",
          "user":  { "context": "$response.body", "selector": "$.profile.id", "type": "jsonpath" },
          "csrf":  { "from": "cookie", "name": "XSRF-TOKEN" },
          "sub":   { "from": "jwt", "token": "{$outputs.token}", "path": "/sub" }
        },
        "expires_in_output": "exp",
        "identity_outputs": ["sub"]
      },
      "limits": { "request_timeout_ms": 10000, "max_response_bytes": 5000000 }
    },
    "delivery": {
      "http": {
        "in": "header",
        "name": "Authorization",
        "prefix": "Bearer ",
        "value": "{$outputs.token}"
      }
    },
    "authorized_uris": ["https://api.example.com/**"]
  }
}
```

Each `outputs` entry is one of:

- **Arazzo runtime-expression string** (Arazzo §5.9) — `$statusCode`,
  `$response.body#/{json-pointer}` (RFC 6901), `$response.header.{name}`,
  `$outputs.{name}`;
- **Arazzo Selector Object** (Arazzo 1.1 §5.8.13) — `{ context, selector, type }` with
  `type ∈ "jsonpath" | "xpath" | "jsonpointer"` (resolved per RFC 9535 / XML Path 3.1 /
  RFC 6901);
- **AFPS extractor object** — `{ from: "cookie", name }`, `{ from: "jwt", token, path }`,
  `{ from: "regex", source, pattern, group }` (extensions Arazzo cannot express).

`success_criteria` is an array of Arazzo Criterion objects (`{ condition, context?, type? }`).
When omitted, success defaults to HTTP 2xx (AFPS-defined; Arazzo leaves HTTP success
undefined).

**Gating rule** (§7.7): a `delivery.*` value template MAY only reference declared
`connect.outputs` (or, for the orchestrated `tool` mode, its declared `produces`).
Referencing a bootstrap login secret like `{$credential.password}` directly in
`delivery.http.value` is a manifest error — the platform decouples acquisition from
delivery.

Anything stateful (cookie jars, multi-step CAS, CSRF token scraping, redirect
following) does **not** belong here — use an orchestrated `tool` (§4 / §5).

---

## 4. Orchestrated, per-run (`custom` + `connect.tool` + `run_at: "run-start"`)

The integration ships an MCP tool that performs the login in code. With
`run_at: "run-start"`, the dashboard **only stores the user's login secret**; the
session is minted fresh inside each agent run's sidecar by the connect-login
primitive. Set `persist_login_secret: true` so the tool can re-bootstrap an expired
session without re-prompting.

`connect.tool` is loosely-defined in AFPS §7.7 — its field shapes are
deliberately experimental at the spec level. The Appstrate platform carries its
fields under the `dev.appstrate/connect` vendor extension key in `_meta` (§10).

```jsonc
"auths": {
  "login": {
    "type": "custom",
    "credentials": {
      "schema": {
        "type": "object",
        "required": ["email", "password"],
        "properties": {
          "email":    { "type": "string", "format": "email" },
          "password": { "type": "string" }
        }
      }
    },
    "connect": {
      "tool": { "name": "perform_login" },
      "_meta": {
        "dev.appstrate/connect": {
          "tool": "perform_login",
          "run_at": "run-start",
          "persist_login_secret": true,
          "reauth_on": [401],
          "outputs": ["JSESSIONID"]
        }
      }
    },
    "delivery": {
      "http": {
        "in": "cookie",
        "name": "JSESSIONID",
        "value": "{$outputs.JSESSIONID}"
      }
    },
    "authorized_uris": ["https://app.example.com/**"]
  }
}
```

- `tool` (string) — name of the MCP tool the platform invokes to acquire the
  credential. Auto-hidden from the agent's tool picker (it's a credential-acquisition
  primitive, not an agent capability).
- `run_at` (`"run-start" | "link"`) — when the tool runs.
- `persist_login_secret` (boolean) — store the user's bootstrap secret so the tool can
  re-run without re-prompting.
- `reauth_on` (array of integers) — upstream HTTP status codes that trigger a re-run
  mid-run (typically `[401]`). The MITM proxy signals the sandbox to re-mint the
  session.
- `outputs` (array of strings) — the authoritative set of injectable names the tool
  produces. These are the names you can reference in `delivery.*.value` as
  `{$outputs.<name>}`.

> Either-or form. New manifests SHOULD use the spec-natural location
> `connect.tool.name`. The vendor-extension form
> `connect._meta["dev.appstrate/connect"].tool` remains accepted for back-compat. The
> other Appstrate-specific fields (`run_at`, `persist_login_secret`, `reauth_on`,
> `outputs`) live under `_meta["dev.appstrate/connect"]` regardless.

---

## 5. Orchestrated, at link (`custom` + `connect.tool` + `run_at: "link"`)

Same orchestrated tool, but the login runs **once** in an ephemeral connect-run when
the user clicks "Connect" (e.g. capturing a durable cookie). The platform launches a
stripped sidecar, runs the untrusted tool, captures the credential bundle, and tears
down.

```jsonc
"auths": {
  "session": {
    "type": "custom",
    "connect": {
      "tool": { "name": "perform_login" },
      "_meta": {
        "dev.appstrate/connect": {
          "tool": "perform_login",
          "run_at": "link",
          "outputs": ["session_cookie"]
        }
      }
    },
    "delivery": {
      "http": {
        "in": "cookie",
        "name": "session",
        "value": "{$outputs.session_cookie}"
      }
    },
    "authorized_uris": ["https://app.example.com/**"]
  }
}
```

Choose `link` when the credential is durable and acquired once. Choose `run-start`
when each run needs a fresh session from a stored secret.

---

## `tools_policy` — per-tool authorization metadata

`tools_policy` (renamed from 1.x `tools` in AFPS) is an OPTIONAL **sparse policy
table** keyed by tool name. It carries per-tool authorization metadata for `local`
and `remote` sources. It is NOT the catalog of "tools this integration exposes" — that
catalog is canonical to the referenced surface (the `_policy` suffix disambiguates).

For `source.kind: "local"`, the canonical catalog is the `tools[]` array of the
referenced `mcp-server` package; for `remote`, it is obtained via runtime
introspection of the MCP endpoint; for `api`, there is no MCP-tool catalog and
`tools_policy` is generally not used.

```jsonc
"tools_policy": {
  "list_issues": {
    "required_scopes": { "oauth": ["repo"] }
  },
  "create_issue": {
    "required_scopes": { "oauth": ["repo", "issues:write"] }
  }
}
```

- `required_scopes` (per-auth map `{ <authKey>: string[] }`) — scopes the tool
  requires, keyed by the `auths.<key>` entry that grants them. Each key MUST be a
  declared `auths` entry, and its scopes MUST be ⊆ that auth's `scope_catalog`. A
  tool MAY list scopes under multiple auths. The selected scopes union into the
  agent-install scope set (§7.4) per auth. This is consent inference only — an auth
  absent from the map serves the tool with no scope requirement, and it is NOT an
  exclusivity lock: any connected auth (e.g. a `pat` alongside `oauth`) may still
  serve the tool at runtime.

### `hidden_tools`

`hidden_tools` is an OPTIONAL array of tool names that exist in the canonical catalog
but MUST NOT be exposed to the agent's tool picker / `tools/list` surface. Tools
referenced by a `connect.tool` (run-start primitives) are auto-hidden, so
`hidden_tools` only needs to enumerate the remaining names to suppress.

```jsonc
"hidden_tools": ["internal_debug_dump", "vendor_legacy_endpoint"]
```

---

## URI restrictions (`authorized_uris` / `allow_all_uris`)

Every auth method MAY restrict which upstream URIs the integration may send
credentials to (§7.9):

- `authorized_uris` (array of strings) — allowed upstream URI patterns. Glob: `*`
  (single segment), `**` (multi-segment).
- `allow_all_uris` (boolean, default `false`) — explicit override permitting any
  upstream URI. Treated as **security-sensitive** by consumers; surface a warning to
  the user.

Consumers MUST NOT send credentials to URIs outside the authorized set unless
`allow_all_uris` is explicitly `true`. URL-encoding bypass, fragment injection, and
open-redirect chains MUST NOT cross the allowlist (§8.6).

The runtime layer (sidecar MITM) enforces this on the wire, including across redirect
hops (per-hop allowlist check, per-hop SSRF blocklist, hybrid credential-strip on
cross-host hops).

---

## `setup_guide`

Human-facing instructions for configuring credentials — typically how to register an
OAuth client.

```jsonc
"setup_guide": {
  "steps": [
    { "label": "Create a Google Cloud project", "url": "https://console.cloud.google.com/projectcreate" },
    { "label": "Configure the OAuth consent screen", "url": "https://console.cloud.google.com/apis/credentials/consent" },
    { "label": "Create OAuth credentials", "url": "https://console.cloud.google.com/apis/credentials" }
  ]
}
```

`callback_url_hint` is auth-method-scoped (`auths.<key>.callback_url_hint`), since the
callback URL depends on the OAuth client registered with the IdP. Use the
`{{callback_url}}` placeholder (this one is **not** a runtime expression — it is a
UI-side substitution the dashboard performs when rendering the hint):

```jsonc
"callback_url_hint": "https://example.com/oauth/clients/new?redirect_uri={{callback_url}}"
```

The top-level `setup_guide.callback_url_hint` from earlier drafts is deprecated;
consumers MUST keep accepting it as a fallback.

---

## Security notes

- The login secret travels in the run's `inputs` plane and is substituted
  **proxy-side** by the sidecar's MITM — the integration's tool code never reads it,
  and it is never logged.
- `connect` is only valid on `type: "custom"`; declare **exactly one** of `login` or
  `tool`.
- The declarative `login` request is bounded by `limits` (`request_timeout_ms`,
  `max_response_bytes`); the orchestrated `tool` runs in the sandboxed runner with
  the per-run CA and MITM envelope.
- `credentials.schema` `$ref` MUST be local fragment-only (`#/...`) — external or
  remote `$ref` is rejected to prevent schema-fetch SSRF (§7.5, §8.7).
- `delivery.http` (proxy injection) and `delivery.env` / `delivery.files` (server
  holds the secret) are mutually exclusive per auth method. Use `http` whenever the
  source server has no business reading the credential.
- For OAuth discovery, the consumer MUST validate `issuer` equality before using any
  endpoint from a `.well-known/` document (§7.3, §8.7).

## What changed since 1.x

- Field names are **snake_case** (`authorization_endpoint`, `token_endpoint`,
  `scope_catalog`, `default_scopes`, `authorized_uris`, `allow_all_uris`, …) — the
  1.x camelCase forms (`authorizationUrl`, `tokenUrl`, `availableScopes`,
  `authorizedUris`) are gone.
- Discovery-first OAuth2 via `issuer` + RFC 8414 / OIDC well-known probing; manual
  endpoints are an override, not the only configuration shape.
- `resource` (RFC 8707) replaces the informal `audience` field.
- `delivery` is mandatory and explicit — `http` (proxy injection) /
  `env` (MCPB-compatible) / `files` (mTLS, service-account JSON).
- New auth type `mtls`; auth type `oauth1` is removed.
- `tools_policy` (renamed from 1.x `tools`) is the per-tool policy table; `hidden_tools`
  suppresses canonical-catalog entries.
- New `source` discriminator (`local | remote | api`) decouples the capability surface
  from the authentication layer.
- The `definition.*` namespace (`authMode`, `oauth2`, `credentialTransform`,
  `credentialEncoding`, `uploadProtocols`, `authorizedUris`, `allowAllUris`,
  `availableScopes`) and `x-*` extension keys are 1.x — all 1.x knobs are now
  expressed under the snake_case `auths.<key>.*` and `source.*` vocabulary, with
  consumer-specific extensions under `_meta` (§10).
