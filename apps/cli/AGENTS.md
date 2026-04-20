# Appstrate CLI — Agent Quickstart

You are an AI coding agent (Claude Code, Cursor, Codex, Gemini CLI, …) and a human has asked you to drive an Appstrate instance. This file is your operating manual. Read it once, then rely on `appstrate --help` and `appstrate openapi` at runtime.

## Mental model

Appstrate is a platform for running autonomous AI agents in sandboxed containers. Its REST API is the single source of truth — 191 endpoints documented in OpenAPI 3.1. The `appstrate` CLI is a thin, authenticated wrapper around that API:

- **`appstrate api`** — `curl`-compatible HTTP passthrough. Replace `curl https://app/api/x` with `appstrate api /api/x`. The CLI injects `Authorization: Bearer <jwt>` + `X-Org-Id` + `X-App-Id` from the OS keyring; you never see the bearer.
- **`appstrate openapi`** — schema explorer. `list` + `show` + `export` let you discover the 191 endpoints without dumping the whole spec into your context window.
- **`appstrate org`** — pin which organization the profile targets (`X-Org-Id`).
- **`appstrate app`** — pin which application the profile targets (`X-App-Id`). Required for app-scoped routes (agents, runs, schedules, …).
- **`appstrate login` / `logout` / `whoami` / `token`** — session management.

Everything else the user asks for — creating an agent, triggering a run, uploading a package, managing webhooks — is expressed as `appstrate api <METHOD> <path>` plus a JSON body. The CLI never hides endpoints from you.

## First call — from zero to a triggered run

Run these commands in order. Each one is idempotent; re-running is safe.

```sh
# 1. Is the CLI authenticated? (exits non-zero if not)
appstrate whoami

# 2. If not authenticated — RFC 8628 device flow. Prints a code + URL;
#    the human approves in a browser, then the CLI stores JWT + refresh
#    token in the OS keyring. Tokens refresh transparently on 401.
appstrate login --instance https://app.example.com

# 3. Confirm which org is pinned (X-Org-Id sent on every call)
appstrate org current

# 3b. Confirm which application is pinned (X-App-Id sent on every call).
#     App-scoped routes (agents, runs, schedules, webhooks, api-keys,
#     notifications, packages, providers, connections, end-users,
#     app-profiles) require this. `login` cascades into the default app
#     automatically, so this usually already prints a value.
appstrate app current

# 4. Discover the "runs" domain. --json produces compact, greppable output.
appstrate openapi list --tag runs --json

# 5. Inspect the operation you want. --json returns the fully dereferenced
#    schema (request body, responses, all $refs inlined) — ideal for
#    building a request body without re-fetching the schema.
appstrate openapi show createRun --json

# 6. List existing agents, pick one
appstrate api GET /api/agents | jq '.[] | {id, name, slug}'

# 7. Trigger a run. -d @file / -d @- / -d '{"…"}' all work like curl.
echo '{"input": {"query": "hello"}}' \
  | appstrate api POST /api/agents/agt_123/run -d @-
```

The server responds via Server-Sent Events. To consume the stream in an agent-friendly way:

```sh
# SSE stream — line-buffered, one JSON event per "data:" line
appstrate api POST /api/agents/agt_123/run \
  -d @input.json \
  -H 'Accept: text/event-stream' \
  -N                                 # disable output buffering
```

## Rules of engagement

1. **Discover before you POST.** Always run `appstrate openapi show <operationId> --json` before constructing a request body. Schemas change; your training data lies.
2. **Never hard-code tokens.** If you find yourself writing `Authorization: Bearer …`, you've failed the design. The CLI owns the bearer; you just call `appstrate api`.
3. **Never print tokens.** `appstrate token` returns metadata only — never the plaintext. Do not try to extract tokens from the keyring.
4. **Respect the org + app boundaries.** `X-Org-Id` and `X-App-Id` are auto-injected from the pinned profile. To operate on a different org, run `appstrate org switch <slug-or-id>` (the app pin cascades automatically). To operate on a different app within the same org, run `appstrate app switch <id>`. Do not forge either header.
5. **Fail fast on auth drift.** If `whoami` exits non-zero mid-session, STOP and tell the human to re-run `appstrate login`. Do not retry blindly.
6. **Use `--profile <name>` for multi-instance.** `--profile dev` / `--profile prod` pick a keyring entry + instance URL pair. Do not hack `~/.config/appstrate/config.toml` by hand.

## Curl → appstrate api mapping (cheat sheet)

Every curl flag you know works identically. Highlights:

| You want                       | Write                                               |
| ------------------------------ | --------------------------------------------------- |
| Method inferred as GET         | `appstrate api /api/x`                              |
| POST with JSON body            | `appstrate api POST /api/x -d @body.json`           |
| POST with body from stdin      | `echo '…' \| appstrate api POST /api/x -d @-`       |
| Multipart upload               | `appstrate api POST /api/x -F 'file=@pkg.zip'`      |
| Custom header (one-off)        | `appstrate api -H 'X-Foo: bar' …`                   |
| Fail on HTTP ≥ 400             | `appstrate api --fail-with-body …`                  |
| Timeout the whole call         | `appstrate api --max-time 30 …`                     |
| Retry with backoff             | `appstrate api --retry 5 …`                         |
| Status-code only, no body      | `appstrate api -w '%{http_code}\n' -o /dev/null …`  |
| Follow redirects (same origin) | `appstrate api -L …` (cross-origin hops strip auth) |

**Differences from curl** (intentional, security-driven):

- No `-u / --user` — the whole point is that you never see the bearer.
- Cross-origin URLs are refused (exit 2). Use plain `curl` if you genuinely need to hit a non-Appstrate host.
- Cookie-jar files (`-b file.txt`) are refused. Literal `-b 'k=v'` works.
- `-d` / `--data-urlencode` do NOT auto-set `Content-Type: application/x-www-form-urlencoded`. Add `-H 'Content-Type: …'` explicitly.

Full table and exit codes: [`apps/cli/README.md#appstrate-api`](./README.md#appstrate-api).

## Common recipes

**Create a local instance from scratch (human runs this, not you):**

```sh
curl -fsSL https://get.appstrate.dev | bash    # drops CLI on PATH + runs install
```

**Trigger an inline run (ephemeral agent, no persistent package):**

```sh
appstrate openapi show POST /api/runs/inline --json    # required fields
appstrate api POST /api/runs/inline -d @manifest.json
```

**List runs for an application, filter by status:**

```sh
appstrate api GET '/api/runs?status=success&limit=20' | jq '.data[]'
```

**Tail run logs (SSE):**

```sh
appstrate api GET /api/runs/run_xyz/events \
  -H 'Accept: text/event-stream' -N
```

**Rotate an API key:**

```sh
appstrate openapi show rotateApiKey --json     # confirm the endpoint shape
appstrate api POST /api/api-keys/ask_xyz/rotate
```

## Escalation

If you hit any of the following, stop and surface the issue to the human instead of guessing:

- `401 unauthorized` after `whoami` passed — the refresh token family was revoked; `appstrate login` needed.
- `403 forbidden` — the pinned org doesn't have permission. Offer `appstrate org switch` or ask which org to use.
- `400 Application context required` — the profile has no `appId` pinned. Run `appstrate app current` to check, then `appstrate app switch` (or surface the error — the cascade at login should have handled this).
- `404 Application '<id>' not found in this organization` — stale app pin from a previous org. Run `appstrate app switch` under the current org.
- `404 not found` on an operationId that `openapi list` shows — the instance version is older than the CLI. Ask the human to upgrade.
- `This CLI is not registered on the target instance` — version incompatibility; do not patch around it.

## Pointers

- CLI reference (full flag tables, write-out variables, exit codes): [`apps/cli/README.md`](./README.md)
- OpenAPI spec (live): `GET /api/openapi.json` on the pinned instance, or `appstrate openapi export -o schema.json`
- Repo overview for contributors (not instance users): [`AGENTS.md`](../../AGENTS.md) at the repo root
