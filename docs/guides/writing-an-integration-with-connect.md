# Writing an integration with `connect`

How an AFPS integration author declares **credential acquisition and delivery** in
`manifest.auths.{key}`. A single declarative substrate covers every shape — the platform
selects a strategy purely from the manifest. This guide maps each declaration to the
strategy it selects, shows the minimal manifest for each, and covers the surrounding
v2 model (sources, delivery vocabulary, per-tool policy, scope catalog).

> Spec: [`afps-spec/spec.md`](../../../afps-spec/spec.md) §3.5 + §7.1–§7.12.
> Canonical examples: [`afps-spec/examples/integration-oauth2`](../../../afps-spec/examples/integration-oauth2/manifest.json),
> [`integration-apikey`](../../../afps-spec/examples/integration-apikey/manifest.json),
> [`integration-basic`](../../../afps-spec/examples/integration-basic/manifest.json).
> Schema reference: `@afps-spec/schema` (`integrationManifestSchema`, `connectSchema`,
> `deliverySchema`, `authMethod`).
> Platform source of truth: `apps/api/src/services/connect/registry.ts` (`resolveStrategy`).

All manifest field names below are **snake_case** — the AFPS wire convention.
All value templates use the Arazzo runtime-expression grammar `{$credential.<field>}`.
A `connect` block's outputs are the connection's credential fields, so they are
referenced as `{$credential.<name>}` too. An integration that declares connection
variables also references them as `{$variable.<name>}` ([Connection variables](#connection-variables-variables)).

```jsonc
{
  "$schema": "https://schemas.afps.dev/v0/integration.schema.json",
  "schema_version": "0.3",
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

// remote — one endpoint per connection (self-hosted instance): see "Connection variables"
"source": { "kind": "remote", "remote": { "url": "{$variable.base_url}/api/v4/mcp", "transport": "streamable-http" } }

// none — serverless: no MCP server
"source": { "kind": "none" }
```

### Enabling `api_call`

`api_call` is an Appstrate vendor capability **orthogonal** to `source.kind` — any
integration (`local`, `remote`, or `none`) can expose it by opting `auths` entries into
the `_meta["dev.appstrate/api"]` extension. Each opted-in auth key (must exist in the
top-level `auths`) yields one `api_call` tool; a single opted-in auth → `api_call`,
multiple → `api_call__<authToken>`. Keys up to 17 characters remain verbatim;
longer AFPS-valid keys use a stable bounded token so the final MCP name stays valid.
The raw long-key spelling is **not** accepted — the alias layer that once
carried it is gone, and a manifest using it resolves no `api_call` surface.
When this extension declares a synthetic name, that name is reserved and takes
precedence over a same-named native MCP tool. A native tool literally named
`api_call__<authKey>` is therefore no longer swallowed by the synthetic surface:
it collides with nothing and stays in the catalog. Without the extension, native
tools named `api_call` or `api_upload` remain ordinary tools.

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
`tool_catalog` (`api_upload__<authToken>` in the multi-auth case) — a chunked/resumable
uploader for workspace files, orchestrated agent-side and dispatched through the
sibling `api_call` tool. Agents get the pair from either name: selecting `api_call`
grants `api_upload` and vice-versa. Hide the companion with
`hidden_tools: ["api_upload"]` if the API's upload surface shouldn't be agent-facing.
Hiding `api_call` also hides its dependent upload companion; an upload without that
sibling is never advertised as callable.

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
e.g. `{$credential.access_token}`, or `{$variable.<name>}` for a declared
[connection variable](#connection-variables-variables) (on an `oauth2` or `connect` auth,
only one the [origin rule](#authorized_uris-and-delivery-the-origin-rule) allows). Any other `{$…}` expression
(`{$outputs.token}`, an undeclared variable, …) is refused when the manifest is saved or
imported, since the platform does not evaluate it.

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
    "identity_claims": { "email": "$.email", "user_id": "$.sub" },
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

### `identity_claims` — naming the connected account

`identity_claims` maps AFPS keys onto accessors into the identity payload. The
platform reads it to derive an **account key**, which is both the connection's
display label and the value that distinguishes two accounts of the same
provider. Resolution, in order:

1. the `account_id` key of your `identity_claims` map (keys are snake_case:
   creating, saving, publishing or importing a manifest that declares any
   other key — `accountId`, `avatarUrl` — is refused);
2. a top-level `email`, `account_email` or `sub` in the payload;
3. the literal `"default"`.

Landing on `"default"` is not an error and nothing is logged: the connection is
simply labelled `Connexion 1`, `Connexion 2`, … and every connection on that
provider shares one account key, so a member holding two accounts cannot tell
them apart. **Declare `account_id` explicitly.** Choose the most human-readable
value that is _unique per account_ — email, else a unique handle, else an opaque
id. A display name that two accounts can share is the wrong choice even though
it reads better.

Accessors are JSONPaths in the single-value RFC 9535 subset the login engine's
selectors use too (`@appstrate/afps-shared/jsonpath`): `$`, `.name`,
`['name']` / `["name"]`, and array indices `[0]` / `[-1]` — a provider that
answers with a single-element list is read as `$.data[0].primaryEmail`.
Filters, slices, wildcards, recursive descent, a `.name` starting with a digit
and a bare name without the `$` are refused when the manifest is imported. A valid path that matches nothing leaves that claim out and falls
through to the chain above — so a typo degrades silently. `apps/api/test/unit/services/system-package-identity-claims.test.ts`
pins every shipped mapping against a payload taken from the provider's docs for
exactly that reason.

The payload is assembled from three layers, earlier layers winning:

1. the token response body;
2. `id_token` claims, when the provider returns one (requesting the `openid`
   scope is often enough — no extra request is made);
3. the body of a `GET` on `userinfo_endpoint`.

Layer 3 is a plain `GET` with `Authorization: Bearer <access_token>` and
`Accept: application/json`. It sends no other header, no request body and no
other method, and it ignores the auth's `delivery` block. A provider whose
identity endpoint needs a `POST` (Dropbox, Slack's `auth.test`), a custom header
(Notion's `Notion-Version`), a non-`Bearer` prefix (Mailchimp's `OAuth`,
Zoho's `Zoho-oauthtoken`) or GraphQL (Linear, monday.com) therefore cannot be
served by layer 3 — declare no `userinfo_endpoint` for those and rely on layers
1–2, or accept `"default"`. A failing userinfo call is best-effort: it warns
server-side and falls through, it never fails the connection.

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
          "body": "{\"email\":\"{{email}}\",\"password\":\"{{password}}\"}"
        },
        "success_criteria": [
          { "condition": "$statusCode == 200", "type": "simple" }
        ],
        "outputs": {
          "token": "$response.body#/access_token",
          "exp":   "$response.header.X-Expires-After",
          "user":  { "context": "$response.body", "selector": "$.profile.id", "type": "jsonpath" },
          "csrf":  { "from": "cookie", "name": "XSRF-TOKEN" },
          "sub":   { "from": "jwt", "token": "{$credential.token}", "path": "/sub" }
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
        "value": "{$credential.token}"
      }
    },
    "authorized_uris": ["https://api.example.com/**"]
  }
}
```

Each `outputs` entry is one of:

- **Arazzo runtime-expression string** (Arazzo §5.9) — `$statusCode`, `$response.body`,
  `$response.body#/{json-pointer}` (RFC 6901), `$response.header.{name}`;
- **Arazzo Selector Object** (Arazzo 1.1 §5.8.13) — `{ context: "$response.body", selector, type }`
  with `type ∈ "jsonpath" | "jsonpointer"` (RFC 9535 / RFC 6901). AFPS also lists `xpath`;
  Appstrate does not evaluate it and refuses it at import;
- **AFPS extractor object** — `{ from: "cookie", name }`, `{ from: "jwt", token, path }`,
  `{ from: "regex", source, pattern, group }` (extensions Arazzo cannot express). A jwt
  `token` names another, non-jwt output as `{$credential.<name>}`; a regex `source` is
  `$response.body` or `$response.header.<name>`.

The login request's `url`, `body` and `headers` carry the user's login inputs as
`{{name}}` (a field of `credentials.schema`); a `{$…}` expression there is refused at
import, as is a runtime expression or selector `context` the login engine cannot
evaluate. That includes `{$variable.<name>}`: a login request takes no connection
variable, so a declarative login cannot target a per-connection upstream.

`success_criteria` is an array of Arazzo Criterion objects (`{ condition, context?, type? }`).
When omitted, success defaults to HTTP 2xx (AFPS-defined; Arazzo leaves HTTP success
undefined). Appstrate evaluates exactly the AFPS §7.7 evaluation profile. Every other form
is refused when the manifest is written (a dependency imported in a bundle gets a warning
instead) and at connect start (`invalid_config`), before any login request is sent:

- `simple` (or `type` omitted): one `<expr> == <operand>` comparison — exactly one `==`;
  no other `=`, `!`, `<`, `>`, `&&`, `||`, `(`, `)` outside a quoted literal; each side a
  runtime expression or a literal, at least one side an expression. A literal is a JSON
  number (`200`, `-1.5`, `2e2`; not `+5`, `.5`, `5.`, `01`, `0x10`), `true`, `false`,
  `null`, or a single-quoted string with `''` for a quote (`'O''Brien'`). Quote every
  string (`$response.body#/status == 'ok'`). Strings compare case-insensitively, as Arazzo
  requires; a number equals a string only when the string is the same JSON number (`'200'`,
  not `' 200'`); an absent value (a missing header or body key) equals nothing. Quotes pair
  across the whole condition, so a JSON pointer key or header name holding an operator
  character, or a quote a later one closes (`$response.body#/it's == 'a'`), is refused:
  check such a key with a `regex` criterion. Appstrate also accepts a double-quoted string
  holding no double quote, which is outside the portable profile. Declare one criterion per comparison (all must pass), omit `success_criteria` to require
  HTTP 2xx, or use `regex` / `jsonpath` for a check an equality cannot express;
- `jsonpath` on `$response.body`, a singular query (`$`, `.name`, `['name']`, `[0]`, `[-1]`);
- `regex` (an ECMA-262 regular expression that must compile) on `$response.body` or one
  `$response.header.<name>`;
- `xpath` is refused.

The same check refuses an output the engine would only find wrong after the login request
is sent: a `regex` pattern that does not compile or does not capture its `group`
(default 1), a `jsonpointer` selector or jwt `path` that is not an RFC 6901 pointer,
and an output that carries both `from` and a Selector field (`context`, `selector`,
`type`): an output is a Selector Object or an extractor, never both.

**Gating rule** (§7.7): a `delivery.*` value template MAY only reference declared
`connect.outputs` (or, for the orchestrated `tool` mode, its declared `produces`), and
only those connection variables the [origin rule](#authorized_uris-and-delivery-the-origin-rule)
allows — none when the auth's upstream is fixed.
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
        "value": "{$credential.JSESSIONID}"
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
  `{$credential.<name>}`.

> **Either-or form — but only one of the two is executed today.** The
> spec-natural location `connect.tool.name` is where the name BELONGS, and it is
> what `getConnectToolNames` (`@appstrate/core/integration`) reads to hide the
> login primitive from the model's tool catalog. The executing path does not
> read it: `OrchestratedStrategy` resolves the name from the vendor-extension
> form `connect._meta["dev.appstrate/connect"].tool` with no fallback, so a
> manifest carrying ONLY the spec-natural name is hidden from the catalog and
> then fails at connect with `Auth '<key>' has no connect.tool declaration`.
>
> The divergence runs the other way too, and that half is quieter: a manifest
> carrying ONLY the vendor-extension form connects fine, but `getConnectToolNames`
> returns `[]` for it, so the login primitive is never added to the hide set and
> stays in the model's tool catalog — the agent can see and call the credential
> -acquisition tool. Nothing fails; the §"auto-hidden" claim below simply is not
> true for that manifest. An author who followed the previous version of this
> note (which blessed the vendor-only form as "accepted for back-compat") is
> shipping exactly that today.
>
> Until the two readers agree, **declare the name in both places** — that is one
> instruction with two independent reasons, one per direction. The fix is
> one shared `connectToolName(auth)` checking both locations, called from
> `getConnectToolNames` and from `OrchestratedStrategy`; the divergence is
> tracked, not designed.
>
> The other Appstrate-specific fields (`run_at`, `persist_login_secret`,
> `reauth_on`, `outputs`) live under `_meta["dev.appstrate/connect"]`
> regardless.

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
        "value": "{$credential.session_cookie}"
      }
    },
    "authorized_uris": ["https://app.example.com/**"]
  }
}
```

Choose `link` when the credential is durable and acquired once. Choose `run-start`
when each run needs a fresh session from a stored secret.

Cookies the upstream sets during a proxy session (one `X-Session-Id` and connection on
the platform proxy, one run in the sidecar), on any hop of a redirect chain, are filed
under the host that set them and replayed there, winning by name over an injected cookie
credential: a rotated session sticks, a deletion falls back to the injected value.
Cookies are host-only: `Domain` and `Path` are ignored (a same-name cookie set for another
path still shadows the injected one on that host), and two hosts share cookies only when
both are literal `authorized_uris` entries. On a redirect to another origin, every path
(platform proxy, sidecar, CLI) keeps the Cookie credential when the allowlist names that
origin and strips it otherwise.

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
  matches within one path segment, and in the host it spans dots; `**` (multi-segment).
- `allow_all_uris` (boolean, default `false`) — explicit override permitting any
  upstream URI. Treated as **security-sensitive** by consumers; surface a warning to
  the user. Appstrate honours it only on a call that carries no credential (below).

Consumers MUST NOT send credentials to URIs outside the authorized set unless
`allow_all_uris` is explicitly `true`. URL-encoding bypass, fragment injection, and
open-redirect chains MUST NOT cross the allowlist (§8.6).

A call that carries a credential — one the caller templates (`{{field}}`) into the
target, a header or a substituted body, or one the proxy injects itself
(`injectsCredential`) — loses `allow_all_uris`: the target and every redirect hop must
match `authorized_uris`, and the call is refused when there is none or when an entry
lets the caller pick the host (`https://**`, `https://*.com/**`). The sidecar, the CLI
resolver and the platform proxy share this rule (`credentialUrlPolicy`); the sidecar's
MITM listener refuses the same calls. An auth that declares no `authorized_uris` and
not `allow_all_uris` has every `api_call` refused, credential or not: an empty
authorized set authorizes nothing.

A wildcard in the host is bounded only when it sits under a registrable domain written
literally in the entry, judged with the [Public Suffix List](https://publicsuffix.org/)
(its ICANN and private sections): `https://*.zendesk.com/**` and
`https://*.example.co.uk/**` are bounded; `https://*.co.uk/**`, `https://*.github.io/**`,
`https://*.googleapis.com/**`, `https://*.supabase.co/**` and `https://*.workers.dev/**`
are not, since the list makes those suffixes public. List such hosts literally
(`https://sheets.googleapis.com/**`), or, when each customer's host sits under such a
suffix, render it from the connection: `https://{$credential.shop_domain}/**`, with the
field validated in `credentials.schema` (a `pattern`) so the rendered host is the one the
API serves. A literal host is bounded whatever its suffix.

Since a host `*` also matches dots, each target is judged as well: a credential reaches a
host a wildcard matched only when that host's own registrable domain lies inside the
literal part of the entry. `https://*.amazonaws.com/**` carries it to
`sts.amazonaws.com` or `iam.amazonaws.com`, but never to a host of a whole region the list
names (every `*.us-east-1.amazonaws.com`, `dynamodb.us-east-1.amazonaws.com` included) nor
to any S3 host (`s3.amazonaws.com`, `bucket.s3.eu-west-1.amazonaws.com`): list those hosts
literally.
The list bounds only the suffixes their operators declare there: the same wildcard still
reaches customer-named endpoints AWS has not listed
(`search-<domain>.eu-west-1.es.amazonaws.com`, a regional search domain), so list hosts
literally wherever that matters.

An integration whose endpoint is per-connection declares it as a URL-form entry
instead of `allow_all_uris`: `"{$credential.site_url}/**"`, or
`"{$credential.webhook_url}"` for one exact URL. The placeholder comes first, alone,
followed by nothing or a suffix starting with `/`; the field must be declared and
`required`. Each connection's list is rendered from its value — an absolute
`http(s)` URL without userinfo, `#`, an empty `?` or `*`, and without a query string
unless the entry is the bare placeholder: `"{$credential.webhook_url}"` is matched
exactly, so a Google Chat or Power Automate URL keeps its `?key=…&token=…` without
widening anything, while a query before a `/**` suffix is refused. Every redirect hop
must match that exact URL too, so a webhook that redirects elsewhere (Google Apps
Script `…/exec` → `script.googleusercontent.com`) is refused. A value that does not
qualify drops the entry, so a connection left with no entry has every call refused;
the platform therefore refuses such a value when the connection is created or its
credentials are updated (a 400 `validation_failed` naming `credentials.<field>` and
the form it must take, never the value).
Prefer the exact form when the host is shared between tenants (`hooks.slack.com`).
Rendered entries never exempt a host from the SSRF blocklist, and never share cookies.

What the guard covers is narrow. A templated credential cannot leave
`authorized_uris`, which bound host and path, not tenant: an allowlisted multi-tenant
API such as `https://discord.com/api/**` still reaches other tenants' endpoints on that
path. An auth whose credential the proxy injects over HTTP (`delivery.http`, or its
type's default header) must name its hosts: the platform refuses a manifest that gives
it `allow_all_uris: true`, no `authorized_uris`, or a host-unbounded `authorized_uris`
entry when it is written (`findUnboundedInjectedCredentials`,
`@appstrate/core/integration`), and the proxies refuse such a call at run time.

The runtime layer (sidecar MITM) enforces this on the wire, including across redirect
hops (per-hop allowlist check, per-hop SSRF gate with the connection pinned to the
validated address, credential stripped on a hop to an origin the allowlist does not
name). For a `source.kind: "local"` integration run in Docker, the same list is also the
runner's whole network egress: a destination it does not grant is refused, and an
auth that declares neither `authorized_uris` nor `allow_all_uris` gives its runner no
way out at all. Only patterns with a `scheme://` count for raw TCP traffic: a pattern
without a port grants only the scheme's default port (443 for https/wss, 80 for
http/ws, 22 for ssh/sftp, none for any other scheme), and a bare `scheme://**` grants
any host on any port.

A `uv` server builds its venv at startup (`uv run` fetches the dependencies from the
package index) through that same egress, and the platform makes no exception for it:
either list the index in `authorized_uris` (`https://pypi.org/**` and
`https://files.pythonhosted.org/**`, or your private index), or vendor the
dependencies in the bundle.

When the target depends on what the user enters (a self-hosted server), reference a
connection field with `{$credential.<field>}`:

```jsonc
"authorized_uris": ["ssh://{$credential.host}:{$credential.port}"]
```

The field must be declared and listed in `credentials.schema.required`, and the entry
must start with `scheme://` with its placeholders in the host and port only (never in
the path or query) — or be a URL-form entry (`{$credential.site_url}/**`, above).
Credential templates are refused on an `oauth2` auth and on an auth that declares
`connect`, whose credential the user does not supply; such an auth bounds a per-connection
upstream with a [connection variable](#connection-variables-variables) instead. At run
time a host or port value containing anything but letters, digits, `.` and `-`, or made
only of dots, drops the pattern, so a user cannot add a wildcard, a separator or another
host.

---

## Connection variables (`variables`)

Use connection variables when **where** the integration connects depends on the
connection: a product offered both as a hosted service and self-hosted (GitLab, Twenty),
a product that is only ever self-hosted (Coolify), a tenant subdomain. The user enters the
values when creating the connection, **before** any authorization step, and every auth of
the integration shares them — so one package serves every instance, and each connection
reaches only its own (AFPS §7.12).

Variables are not credentials. The platform stores them in plaintext, shows them on the
connection and may log them; never declare a secret as a variable — a token belongs in
`credentials.schema`. Prefer a variable over a `{$credential.<field>}` URL as soon as the
value must choose the MCP endpoint or the OAuth authorization server: a credential
field can do neither, and is not allowed at all on an `oauth2` auth.

```jsonc
"variables": {
  "schema": {
    "type": "object",
    "properties": {
      "base_url": {
        "type": "string",
        "format": "uri",
        "pattern": "^https?://",
        "title": "URL de l'instance GitLab",
        "description": "Racine de votre instance, sans chemin (ex. https://gitlab.example.com).",
        "default": "https://gitlab.com"
      }
    },
    "required": ["base_url"]
  }
}
```

- `variables.schema` is a self-contained JSON Schema 2020-12 object (local `$ref` only)
  with at least one property. Each property is a variable: its name matches
  `^[a-z][a-z0-9_]*$`, its `type` is `"string"`, and it is listed in `required` — which
  names nothing else. Constrain the value with `format`, `pattern` or `enum`.
- `title` and `description` label the form field (French for an Appstrate system
  package, like every other user-facing string). `default` only prefills the form; a
  connection's value is always one the user submitted.
- Variables and credential fields are separate namespaces and may share a name.

### Where a variable may appear

`{$variable.<name>}` is accepted in exactly these places, and every reference must name a
declared variable — anything else is refused when the manifest is saved, published or
imported:

| Field                                                                                   | Form                               |
| --------------------------------------------------------------------------------------- | ---------------------------------- |
| `source.remote.url`                                                                     | URL template                       |
| `auths.<key>.issuer` (`oauth2`)                                                         | URL template                       |
| `auths.<key>.authorized_uris[i]`                                                        | URL form or authority form (below) |
| `auths.<key>.delivery.http.value`, `delivery.env.<n>.value`, `delivery.files.<p>.value` | value template, raw substitution   |

Endpoints (`authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`), `resource`,
`setup_guide` and every other field stay literal: an endpoint chosen apart from the
issuer would receive the client credentials of the issuer's client.

### URL templates: URL form vs host form

A URL template takes one of two forms:

- **URL form** — the placeholder, then nothing or a path: `{$variable.base_url}/api/v4/mcp`.
  The value is a whole URL: absolute, `http` or `https`, a host, no userinfo, no query
  (not even an empty `?`), no fragment, no `*`. With a path, the template renders as the
  value's origin and path with every trailing `/` removed, followed by the template's
  path: `https://git.example.com/gitlab/` renders
  `https://git.example.com/gitlab/api/v4/mcp`. Without one, it renders as the value
  itself, normalised (`https://gitlab.com` → `https://gitlab.com/`). Use it when users
  type an address — it covers a server under a path prefix.
- **Host form** — `https://`, the placeholder, literal labels, then nothing or a path:
  `https://{$variable.tenant}.example.com/mcp`. The value is one or more labels of
  letters, digits and `-` (no leading or trailing `-`); the rendered host is at most 253
  characters, and is lowercased like every rendered host (the platform uses the WHATWG
  serialisation). Use it for a tenant name on the vendor's
  own domain.

A path is `/`-prefixed segments of letters, digits and `-._~!$&'()+,;=:@` (no empty,
`.` or `..` segment), optionally ending with `/`. Rendering is plain concatenation,
never relative resolution.

The value must be `https` in practice: the platform's egress check refuses a rendered
`http` URL unless the operator lists its host in `EGRESS_ALLOW_INTERNAL_HOSTS`, and
refuses a private, loopback or metadata address whatever the scheme. Declaring
`"pattern": "^https?://"` keeps that operator option open; `"^https://"` closes it in
the form.

A connection whose values would leave a template its auth uses unrenderable is refused
when it is created (400 `validation_failed` on `variables.<name>`), and a value can only
change through a reconnect, which acquires a new credential for the new upstream.

### `authorized_uris` and delivery: the origin rule

An `authorized_uris` entry carrying a variable takes the URL form
(`{$variable.base_url}/api/v4/**`, rendered like a URL template followed by the suffix)
or the authority form with the variable filling the host, alone or before literal labels,
and no port (`https://{$variable.tenant}.example.com/**`).

On an `oauth2` auth, or one that declares `connect`, the credential is issued for an
upstream, and a URL template may choose it:

| Auth                       | Template that chooses the upstream                                        |
| -------------------------- | ------------------------------------------------------------------------- |
| `oauth2`                   | a templated `source.remote.url` (the resource), else a templated `issuer` |
| `custom` + `connect.tool`  | a templated `source.remote.url`                                           |
| `custom` + `connect.login` | none — a login request takes no variable, so its upstream is fixed        |

Two rules follow, both so that a credential reaches only the origin it was issued for:

- each `authorized_uris` entry carrying a variable must **share that template's origin**:
  the same leading placeholder in the URL form; in the authority form, the same scheme
  and host as a host-form template. With `"url": "{$variable.base_url}/api/v4/mcp"`,
  `{$variable.base_url}/api/v4/**` qualifies and `https://{$variable.base_url}/**` or an
  entry over another variable does not;
- a `delivery` value template may reference only the variables of that template.

When the upstream is fixed — no templated remote URL or issuer, or a `connect.login`
auth — neither an entry nor a delivery template of the auth may carry a variable: it
would send a fixed issuer's credential wherever the user points. On an `api_key`,
`basic`, `mtls` or `custom` auth without `connect` the user supplies the credential
itself, and any declared variable may bound or shape it.

### OAuth against the server the user named

When `source.remote.url` (or an `oauth2` `issuer`) is a template, the authorization
server is the user's choice, not yours. Declare no endpoint and no `resource`. For a
templated remote URL the platform fetches the RFC 9728 protected-resource metadata of the
rendered URL in the MCP order — the `resource_metadata` of a `WWW-Authenticate`
challenge, the path-inserted well-known location, the root one — and uses a document only
when its `resource` is the identifier that location was derived from (the rendered URL,
or its origin for the root location), trying the next location otherwise. It then takes
the entry of `authorization_servers` equal to the rendered `issuer` when you declare one
— a template over the remote URL's variables — and otherwise one with the rendered URL's
origin, and refuses the connection when there is none. Endpoints come from RFC 8414
discovery of that server alone, and the RFC 8707 `resource` is always sent for a remote
source. The client is registered by RFC 7591 Dynamic Client Registration as a public
client, one per authorization server and integration (and space), and the redirect URI
is distinct per server.

Declare `issuer` when the product may be served under a path prefix: its authorization
server is then `https://host/prefix`, which does not have the origin of the rendered URL.
`@appstrate/gitlab-mcp` declares `"issuer": "{$variable.base_url}"` for that reason.

A server without dynamic client registration cannot be connected: an admin cannot
register a client by hand for an auth whose server each connection names. Declare
`token_endpoint_auth_method: "none"` and the scopes the server expects in
`default_scopes`.

### Examples

GitLab — one OAuth auth, gitlab.com by default, any self-managed instance by URL
(`scripts/system-packages/integration-gitlab-mcp-1.0.0/manifest.json`):

```jsonc
"source": {
  "kind": "remote",
  "remote": { "url": "{$variable.base_url}/api/v4/mcp", "transport": "streamable-http" }
},
"variables": {
  "schema": {
    "type": "object",
    "properties": {
      "base_url": { "type": "string", "format": "uri", "pattern": "^https?://", "default": "https://gitlab.com" }
    },
    "required": ["base_url"]
  }
},
"auths": {
  "oauth": {
    "type": "oauth2",
    "issuer": "{$variable.base_url}",                // the instance, path prefix included
    "token_endpoint_auth_method": "none",
    "code_challenge_methods_supported": ["S256"],
    "default_scopes": ["mcp"],
    "authorized_uris": ["{$variable.base_url}/api/v4/**"],
    "delivery": {
      "http": { "in": "header", "name": "Authorization", "prefix": "Bearer ", "value": "{$credential.access_token}" }
    }
  }
}
```

Coolify — always self-hosted, so no `default`, and a team token the user pastes
(`scripts/system-packages/integration-coolify-mcp-1.0.0/manifest.json`):

```jsonc
"source": {
  "kind": "remote",
  "remote": { "url": "{$variable.base_url}/mcp", "transport": "streamable-http" }
},
"variables": {
  "schema": {
    "type": "object",
    "properties": {
      "base_url": { "type": "string", "format": "uri", "pattern": "^https?://" }
    },
    "required": ["base_url"]
  }
},
"auths": {
  "api_key": {
    "type": "api_key",
    "credentials": {
      "schema": {
        "type": "object",
        "properties": { "token": { "type": "string" } },
        "required": ["token"]
      }
    },
    "authorized_uris": ["{$variable.base_url}/**"],
    "delivery": {
      "http": { "in": "header", "name": "Authorization", "prefix": "Bearer ", "value": "{$credential.token}" }
    }
  }
}
```

`@appstrate/twenty-mcp` combines both shapes: one OAuth auth and one API-key auth over
the same `base_url`.

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

Steps are static: a step's `label` and `url` cannot reference a connection variable.
They are admin setup for registering an OAuth app, so a remote MCP integration whose
client is registered dynamically, or one with no OAuth auth, ships none. What a user
needs while connecting — where to find the instance URL, which screen creates the token,
what the server's administrator must enable first — goes in the `description` of the
variable or credential field, which the connect form renders next to its input.

`callback_url_hint` is auth-method-scoped (`auths.<key>.callback_url_hint`), since the
callback URL depends on the OAuth client registered with the IdP. Use the
`{{callback_url}}` placeholder (this one is **not** a runtime expression — it is a
UI-side substitution the dashboard performs when rendering the hint):

```jsonc
"callback_url_hint": "https://example.com/oauth/clients/new?redirect_uri={{callback_url}}"
```

The top-level `setup_guide.callback_url_hint` from earlier drafts is deprecated;
consumers MUST keep accepting it as a fallback.

The dashboard substitutes `{{callback_url}}` with the callback it will actually send for
the client being configured — the client's own `redirect_uri` override when it has one,
else the platform callback. Substitution is raw, with no percent-encoding, because a hint
is prose as often as it is a deep link; in the deep-link form the value lands in a query
parameter, where RFC 3986 §3.4 already permits the `:` and `/` an unencoded URL
contributes. A hint that resolves to a whole `http(s)` URL is rendered as a link, anything
else as text — the string is publisher-controlled, so it never becomes a navigation sink.

Write the hint to name the screen and field, not to restate the URL: the dashboard already
shows the callback with a copy button right above the form. A hint that omits
`{{callback_url}}` is something the UI could have hard-coded, and a conformance test
rejects it.

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
- A URL rendered from connection variables is chosen by the user who creates the
  connection, not by the author (§7.12, §8.6): the platform egress-checks it like any
  user-supplied URL, and treats every URL a response to it hands back (discovery
  documents, `WWW-Authenticate`, redirects) the same way.

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
