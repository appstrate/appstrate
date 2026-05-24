# Writing an integration with `connect`

How an integration author declares **credential acquisition** in `manifest.auths.{key}`.
A single abstraction (`ConnectStrategy`) covers every shape; the platform picks the
strategy purely from the manifest. This guide maps each declaration to the strategy it
selects and shows the minimal manifest for each.

> Source of truth: `apps/api/src/services/connect/registry.ts` (`resolveStrategy`) and the
> `auths.{key}` schema in `packages/core/src/integration.ts`.

## Strategy selection at a glance

| `auth.type`         | `connect` | `connect.runAt` | Strategy     | Flow                                                |
| ------------------- | --------- | --------------- | ------------ | --------------------------------------------------- |
| `oauth2`            | —         | —               | OAuth2       | OAuth 2.0 + PKCE, auto-refresh                      |
| `api_key` / `basic` | —         | —               | Fields       | paste-the-bag (user submits the credential)         |
| `custom`            | _absent_  | —               | Fields       | paste-the-bag, free-form schema                     |
| `custom`            | `login`   | —               | Login        | one declarative login request                       |
| `custom`            | `tool`    | `run-start`     | LoginSecret  | store the secret, mint the session at each run      |
| `custom`            | `tool`    | `link`          | Orchestrated | run the login tool once in an ephemeral connect-run |

`oauth1` is **not** a valid auth type — it was removed (no working connect path, signing
never implemented).

---

## 1. OAuth 2.0 (`oauth2`)

For IdPs that support the authorization-code + PKCE flow. `authorizationUrl` and `tokenUrl`
are **required** (no discovery). Declare the scope catalog via `availableScopes` so the
runtime can infer the least-privilege scope union from agents' tool selection.

```jsonc
"auths": {
  "oauth": {
    "type": "oauth2",
    "authorizationUrl": "https://example.com/oauth/authorize",
    "tokenUrl": "https://example.com/oauth/token",
    "availableScopes": [
      { "value": "read", "label": "Read access" },
      { "value": "write", "label": "Write access" }
    ]
  }
}
```

Token refresh is automatic (proactive near expiry + on a mid-run `401`). Nothing else to wire.

## 2. Paste-the-bag (`api_key` / `basic` / bare `custom`)

The user submits the credential through the dashboard fields modal. `custom` lets you define
an arbitrary credential schema; `api_key` / `basic` use the canonical fields (`api_key`,
`username` / `password`).

```jsonc
"auths": {
  "token": { "type": "api_key" }
}
```

Use `delivery.http` to control how the credential is injected on outbound calls (header name,
prefix, source field). See the `@appstrate/connect` README for the per-type defaults.

## 3. Declarative login (`custom` + `connect.login`)

For services where a **single** stateless HTTP request exchanges a user-supplied secret
(password, API token) for a session credential — no redirect chain, no impersonation. Exactly
**one** request. Extract the credential from the response with `extract`.

```jsonc
"auths": {
  "session": {
    "type": "custom",
    "connect": {
      "login": {
        "request": { "method": "POST", "url": "https://example.com/login" },
        "extract": { "session_token": { "from": "body", "jsonPath": "$.token" } }
      },
      "limits": { "timeoutMs": 10000 }
    }
  }
}
```

Anything stateful (cookie jars, multi-step CAS, CSRF token scraping, redirect following)
does **not** belong here — use an orchestrated `tool` (§4/§5).

## 4. Orchestrated, per-run (`custom` + `connect.tool` + `runAt: "run-start"`)

The integration ships an MCP tool (named by `connect.tool`) that performs the login in code.
With `runAt: "run-start"`, the dashboard **only stores the user's login secret**; the session
is minted fresh inside each agent run's sidecar by the connect-login primitive. Set
`persistLoginSecret: true` so the tool can re-bootstrap an expired session without re-prompting.

```jsonc
"auths": {
  "login": {
    "type": "custom",
    "connect": {
      "tool": "login",
      "runAt": "run-start",
      "persistLoginSecret": true,
      "reauthOn": [401],
      "outputs": ["JSESSIONID"]
    }
  }
}
```

`reauthOn` lists the upstream status codes (typically `[401]`) on which the MITM proxy signals
the sandbox to re-run the login tool mid-run. `outputs` is the authoritative set of injectable
values the tool produces.

## 5. Orchestrated, at link (`custom` + `connect.tool` + `runAt: "link"`)

Same orchestrated tool, but the login runs **once** in an ephemeral connect-run when the user
clicks "Connect" (e.g. capturing a durable cookie). The platform launches a stripped sidecar,
runs the untrusted tool, captures the credential bundle, and tears down.

```jsonc
"auths": {
  "login": {
    "type": "custom",
    "connect": { "tool": "login", "runAt": "link", "outputs": ["session_cookie"] }
  }
}
```

Choose `link` when the credential is durable and acquired once; choose `run-start` when each
run needs a fresh session from a stored secret.

---

## Security notes

- The login secret travels in the run's `inputs` plane and is substituted **proxy-side** by the
  sidecar's MITM — the integration's tool code never reads it, and it is never logged.
- `connect` is only valid on `type: "custom"`; declare **exactly one** of `login` or `tool`.
- The declarative `login` request is bounded by `limits` (timeout, body size); the orchestrated `tool`
  runs in the sandboxed runner with the per-run CA and MITM envelope.
