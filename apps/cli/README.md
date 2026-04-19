# Appstrate CLI

`appstrate` is the official command-line tool for installing, configuring, and authenticating against an Appstrate instance. It is a single self-contained binary (Bun runtime embedded) — no Node.js, npm, or pre-installed dependencies required on the host.

Lives at [`apps/cli/`](./) in the monorepo; versioned in lockstep with the platform ([ADR-006](../../docs/adr/ADR-006-cli-device-flow-monorepo.md)).

> **Driving this CLI from an AI coding agent?** Read [`AGENTS.md`](./AGENTS.md) first — it distills this reference into a zero-to-first-run recipe, rules of engagement, and a `curl` → `appstrate api` cheat sheet sized for an agent's context window.

## Install

### One-liner (recommended)

```sh
curl -fsSL https://get.appstrate.dev | bash
```

Detects your OS/arch, downloads the matching binary from [GitHub Releases](https://github.com/appstrate/appstrate/releases/latest), drops it at `/usr/local/bin/appstrate`, and immediately execs `appstrate install`.

Supported: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. **Windows is not a v1 target** — run the one-liner inside WSL2 (which reuses the `linux-x64` binary), or invoke `bunx appstrate install` natively if you already have Bun on Windows.

### Alternate install paths

```sh
# Verified one-liner — fetches + minisign-verifies + runs
curl -fsSL https://get.appstrate.dev/verify.sh | bash

# Bun-native (if you already have Bun)
bunx appstrate install
```

See [`examples/self-hosting/README.md`](../../examples/self-hosting/README.md#verifying-the-installer) for signature verification details (minisign + SLSA build provenance).

## Commands

| Command             | Purpose                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `appstrate install` | Install Appstrate locally (Tier 0) or bring up a Docker stack (Tiers 1/2/3).   |
| `appstrate login`   | Sign into an instance via RFC 8628 device-flow. Tokens land in the OS keyring. |
| `appstrate logout`  | Revoke the active session server-side and wipe local credentials.              |
| `appstrate whoami`  | Print the identity attached to the active profile.                             |
| `appstrate token`   | Print metadata about the stored access + refresh tokens (debug).               |
| `appstrate org`     | List, switch, or create organizations pinned on the active profile.            |
| `appstrate api`     | Authenticated HTTP passthrough to the Appstrate API.                           |
| `appstrate openapi` | Explore the active profile's OpenAPI schema without flooding stdout.           |

All commands accept `--profile <name>` to target a specific profile (see [Profiles](#profiles)).

---

### `appstrate install`

Interactive installer for a local Appstrate instance. Prompts for a tier, writes a generated `.env` with cryptographic secrets, and brings the stack up — then opens `http://localhost:3000` once the healthcheck passes.

```sh
appstrate install                     # interactive
appstrate install --tier 3            # skip the tier prompt
appstrate install --tier 0 --dir ~/demo-appstrate
```

**Flags**

| Flag           | Values       | Description                                 |
| -------------- | ------------ | ------------------------------------------- |
| `-t`, `--tier` | `0\|1\|2\|3` | Skip the interactive tier prompt.           |
| `-d`, `--dir`  | path         | Install directory (default: `~/appstrate`). |

**Tiers**

| Tier | Runtime deps | Services                   | Storage    | Notes                                                  |
| ---- | ------------ | -------------------------- | ---------- | ------------------------------------------------------ |
| 0    | Bun          | None (PGlite in-process)   | Filesystem | Hobby / evaluation. CLI auto-installs Bun if missing.  |
| 1    | Docker       | PostgreSQL                 | Filesystem | Low-traffic single-node. In-memory scheduler / pubsub. |
| 2    | Docker       | PostgreSQL + Redis         | Filesystem | Adds Redis (BullMQ, distributed rate-limiter).         |
| 3    | Docker       | PostgreSQL + Redis + MinIO | S3         | Full production stack (default self-host target).      |

**Tier 0 specifics**: `git clone`s the `appstrate/appstrate` monorepo at the CLI's release tag, runs `bun install`, writes `.env`, and `bun run dev` spawns the platform as a detached process. If Bun is absent, the CLI prompts to install it via the official installer into `~/.bun/bin` (user-local, no sudo).

**Tier 1/2/3 specifics**: checks `docker info`, writes `docker-compose.yml` from an embedded template (`examples/self-hosting/docker-compose.tier{1,2,3}.yml`), writes `.env`, runs `docker compose up -d`, polls `/` for up to 120s.

---

### `appstrate login`

Authenticate against a running Appstrate instance via [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device-authorization grant. The CLI displays a short user-code + URL; the user visits the URL in a browser, signs in, and approves the device. The CLI polls the token endpoint until approved, stores the resulting session token in the OS keyring, and persists the profile in `~/.config/appstrate/config.toml`.

```sh
appstrate login                                          # interactive prompt for instance URL
appstrate login --instance http://localhost:3000         # skip prompt
appstrate login --profile prod --instance https://app.my.io
```

**Flags**

| Flag              | Values         | Description                                                                                                                                   |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--instance`      | URL            | Instance base URL. Skips the interactive prompt.                                                                                              |
| `-p`, `--profile` | name           | Profile name to store credentials under (default: `default`).                                                                                 |
| `--org`           | `<id-or-slug>` | After the token exchange, pin this organization on the profile non-interactively. Fails if the reference does not match any org.              |
| `--create-org`    | `<name>`       | Create a new organization with this name and pin it. A default application + hello-world agent are provisioned server-side. Skips the prompt. |
| `--no-org`        | —              | Skip the post-login org-pinning step entirely. Subsequent calls must carry `-H 'X-Org-Id: …'`, or pin later via `appstrate org switch`.       |

**Org pinning after login** (issue #209): on success, the CLI calls `GET /api/orgs` and branches:

- **Exactly one org** → auto-pin. The success banner names it: `Logged in as … to "Acme" (org_xxx)`.
- **Zero orgs** (fresh signup, dashboard onboarding skipped) → offer inline creation (`POST /api/orgs`) which also provisions a default application + hello-world agent server-side.
- **≥2 orgs** → interactive picker.

The pinned org id is written to `config.toml` and automatically sent as `X-Org-Id` on every subsequent `appstrate api` call, so `appstrate api GET /api/me` works immediately after a fresh login with no extra flags.

**Flow** (what happens on the wire):

1. `POST /api/auth/device/code` → receive `device_code`, `user_code`, `verification_uri_complete`, `expires_in` (10 min), `interval` (5s).
2. CLI prints the code, opens the verification URI in the browser via the [`open`](https://www.npmjs.com/package/open) package (silent fallback on headless hosts — the URL is still displayed in the terminal).
3. User authenticates on the instance's `/activate` SSR page and clicks "Autoriser". A realm guard on `/device/approve` rejects cross-audience approval attempts (e.g. an application-level end-user trying to approve a CLI session) — see [ADR-006](../../docs/adr/ADR-006-cli-device-flow-monorepo.md) for rationale.
4. CLI polls `POST /api/auth/cli/token` every `interval` seconds (honoring `slow_down` backoff) until approval. On success: receives an `access_token` (15-minute signed JWT, ES256) + `refresh_token` (30-day opaque rotating token) pair — see issue #165.
5. CLI decodes the JWT payload locally to extract `sub` (user id) and `email` from its claims. No second round-trip needed — the JWT is the authoritative identity source, and `/api/auth/get-session` does not understand Bearer JWTs (that endpoint is BA's cookie-based session reader).
6. Tokens are stored in the OS keyring; profile is written to `config.toml`.

**Session lifetime**: 15-minute access token + 30-day rotating refresh token (RFC 6819 §5.2.2.3 reuse detection). The CLI transparently refreshes on 401; re-run `appstrate login` only when the refresh token family is revoked or the 30-day window elapses.

---

### `appstrate logout`

Revokes the active session server-side (`POST /api/auth/sign-out`) and wipes the local keyring entry + profile from `config.toml`.

```sh
appstrate logout
appstrate logout --profile prod
```

**Flags**

| Flag              | Values | Description                                   |
| ----------------- | ------ | --------------------------------------------- |
| `-p`, `--profile` | name   | Profile to log out from (default: `default`). |

If the instance is unreachable, local credentials are still wiped (with a warning on stderr) so the CLI returns to a clean state even during outages.

---

### `appstrate whoami`

Prints the identity attached to a profile. Verifies the stored JWT is still valid by calling `GET /api/profile` (a 401 surfaces as a clear "re-login" error); the email comes from the profile persisted at login.

```sh
appstrate whoami
appstrate whoami --profile prod
```

Output:

```
Profile:  default
Instance: https://app.example.com
User:     alice@example.com
Name:     Alice
Expires:  2026-04-25T00:36:40.285Z
```

Exits non-zero if the profile is missing, the session is revoked, or the instance is unreachable — useful in CI scripts that need to fail fast when auth drifts.

---

### `appstrate token`

Prints metadata about the access + refresh tokens stored for a profile. **Metadata only** — the token plaintext is never written to stdout or stderr, so copy-pasting the output into a screen share, a CI log, or a bug report never leaks a bearer.

```sh
appstrate token
appstrate token --profile prod
```

Output:

```
Profile:           default
Instance:          https://app.example.com

Access token
  Status:          fresh
  Expires:         in 14m 32s
  Expires at:      2026-04-19T16:23:45.000Z

Refresh token
  Status:          valid
  Expires:         in 29d 23h
  Expires at:      2026-05-18T16:08:45.000Z

JWT claims
  iss:             https://app.example.com/api/auth
  aud:             https://app.example.com/api/auth
  sub:             usr_abc123
  azp:             appstrate-cli
  actor_type:      user
  scope:           cli
  iat:             1713543325 (2026-04-19T16:08:45.000Z)
  exp:             1713544225 (2026-04-19T16:23:45.000Z)
  jti:             ab12cd34…
```

Status vocabulary:

- **Access**: `fresh` (> 30s remaining) · `rotating-soon` (< 30s — `api.ts` will rotate on the next call) · `expired` (past TTL; claims still render for diagnostics)
- **Refresh**: `valid` (> 24h remaining) · `expiring-soon` (< 24h) · `expired` (re-run `appstrate login`) · `not stored` (legacy 1.x credentials)

No network call — this command inspects local state only. A refresh token revoked server-side still looks `valid` here by design. Use `whoami` for a server-authoritative identity check.

If the JWT `exp` claim and the locally stored `expiresAt` diverge by more than 2 seconds, `token` flags the mismatch — `api.ts`'s proactive-rotation logic keys off the stored value, so a skew between the two is worth surfacing before it causes unexpected 401s.

---

### `appstrate org`

Manage the organization pinned on the active profile. `login` auto-pins an org where possible (see above); `org switch` / `org create` let you change the pin without re-running the device flow. The pinned org id is sent as `X-Org-Id` on every `appstrate api` call and every `/api/*` endpoint that requires org context.

```sh
appstrate org list            # enumerate orgs the profile has access to; pinned row is marked *
appstrate org switch          # interactive picker (current org pre-highlighted)
appstrate org switch acme     # non-interactive — by slug or id
appstrate org current         # print the pinned orgId (scripts / shell prompts)
appstrate org create          # interactive (name + optional slug) → auto-pin
appstrate org create "Acme"   # non-interactive → auto-pin
appstrate org create "Acme" --slug acme-prod
```

All four subcommands respect the global `--profile <name>` flag and talk to `GET /api/orgs` / `POST /api/orgs`. Creating an org server-side also provisions a default application + a hello-world agent, so the CLI lands on a fully-working setup with no extra steps.

**Subcommands**

| Subcommand              | Purpose                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `org list`              | List the orgs the active profile belongs to. The pinned one is marked with `*`.                                                          |
| `org switch [id\|slug]` | Re-pin the active org on the profile. With no argument, show an interactive picker with the current one highlighted.                     |
| `org current`           | Print the pinned org id to stdout. Exits 1 with a hint when no org is pinned — designed for `if` / shell prompts.                        |
| `org create [name]`     | Create a new org and pin it. With no argument, prompt for name + optional slug. Use `--slug <slug>` for an explicit kebab-case override. |

---

### `appstrate openapi`

Explore the active profile's OpenAPI 3.1 schema without dumping the whole spec to stdout. The platform exposes ~191 endpoints — `list`, `show`, and `export` subcommands make that corpus explorable at human scale (and agent-ingestable with `--json`).

The schema is fetched once per profile and cached under `~/.cache/appstrate/openapi-<profile>.json` (or `$XDG_CACHE_HOME/appstrate/…`). Each cached copy pairs with an ETag sibling — subsequent invocations send `If-None-Match` and short-circuit on a `304` response, so re-running `list` / `show` during exploration costs one conditional round-trip instead of re-downloading the full spec.

```sh
appstrate openapi list                              # all operations, one per line
appstrate openapi list --tag runs                   # filter by tag
appstrate openapi list --method post                # filter by HTTP method
appstrate openapi list --path '/api/runs/*'         # filter by path glob
appstrate openapi list --search "create run"        # fuzzy match on id / summary / path
appstrate openapi list --json                       # machine-readable index

appstrate openapi show createRun                    # by operationId
appstrate openapi show GET /api/runs                # by METHOD + path
appstrate openapi show createRun --json             # full dereferenced object (agent input)

appstrate openapi export                            # dump raw schema to stdout
appstrate openapi export -o schema.json             # dump to file
```

**Subcommand flags**

| Subcommand | Flag             | Description                                                                      |
| ---------- | ---------------- | -------------------------------------------------------------------------------- |
| `list`     | `--tag <t>`      | Filter by OpenAPI tag (case-insensitive exact match).                            |
| `list`     | `--method <m>`   | Filter by HTTP method (`GET`, `POST`, …).                                        |
| `list`     | `--path <glob>`  | Filter by path. Supports `*` (single segment) and `**` (any). Exact match else.  |
| `list`     | `--search <q>`   | Case-insensitive substring across operationId, summary, description, path.       |
| `list`     | `--json`         | Emit a minimal JSON array (method, path, operationId, summary, tags) for piping. |
| `show`     | `--json`         | Emit the full dereferenced operation as JSON instead of the text summary.        |
| `export`   | `-o`, `--output` | Write the schema to a file (default: stdout).                                    |

**Shared flags** (all three subcommands)

| Flag         | Description                                                           |
| ------------ | --------------------------------------------------------------------- |
| `--refresh`  | Force a fresh download; still update the on-disk cache on success.    |
| `--no-cache` | Fully ephemeral — skip both cache read and write for this invocation. |

**`list` output** — one colored line per operation:

```
GET    /api/runs — List runs [runs]
POST   /api/runs — Create a run [runs]
GET    /api/runs/{id} — Get a run [runs]
DELETE /api/runs/{id} — Cancel a run [runs]
GET    /api/deprecated — Legacy endpoint [legacy] [deprecated]
```

Colors are suppressed when stdout is not a TTY, or when `NO_COLOR` is set in the environment (respects [no-color.org](https://no-color.org)).

**`show` output** — a human-readable operation summary. For `--json`, the response uses `@apidevtools/swagger-parser` to dereference every `$ref` in the operation tree, so nested request/response schemas inline fully — ideal for piping into an LLM prompt or a code generator.

**`export` output** — the raw schema JSON. Use `-o schema.json` for file output (mode `0600`) or stdout for shell piping (`appstrate openapi export | jq '.info'`). Equivalent to calling `appstrate api GET /api/openapi.json`, but served from the local cache when possible.

---

### `appstrate api`

Curl-like authenticated HTTP passthrough. Purpose-built so coding agents (Claude Code, Cursor, Aider, …) can call the Appstrate API in a shell-one-liner without ever seeing the raw bearer — the CLI injects `Authorization: Bearer …` + `X-Org-Id` from the keyring-backed profile.

```sh
appstrate api GET /api/agents
appstrate api /api/agents                         # method inferred
appstrate api POST /api/agents/abc/run -d '@req.json'
appstrate api https://app.example.com/api/health  # absolute URL ok if origin matches profile
```

#### curl → appstrate api mapping

Every row below is a direct drop-in: an agent can replace `curl` with `appstrate api` and strip the hostname. All flags work identically.

| curl                            | `appstrate api`                       | Notes                                             |
| ------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `curl https://app/api/x`        | `appstrate api /api/x`                | method defaults to GET                            |
| `curl -X POST -d @body …`       | `appstrate api POST /api/x -d @body`  | literal `/ @file / @-` for stdin                  |
| `curl -F 'file=@pkg.zip'`       | `appstrate api -F 'file=@pkg.zip'`    | `;type=mime` supported                            |
| `curl -H 'X-Foo: bar'`          | `appstrate api -H 'X-Foo: bar'`       | repeatable; wins over defaults                    |
| `curl --data-urlencode 'k=v w'` | same                                  | repeatable; 5 curl forms incl. `@file` / `@-`     |
| `curl -G --data-urlencode …`    | `appstrate api -G --data-urlencode …` | `-G` projects values into the query string        |
| `curl -T file`                  | `appstrate api -T file /x`            | PUT by default; `-T -` for stdin                  |
| `curl -i`                       | `appstrate api -i`                    | status line + headers on stdout                   |
| `curl -I`                       | `appstrate api -I`                    | HEAD only                                         |
| `curl -L`                       | `appstrate api -L`                    | cross-origin hops strip `Authorization`           |
| `curl -k`                       | `appstrate api -k`                    | skip TLS verification (this request)              |
| `curl -o out`                   | `appstrate api -o out`                | body → file                                       |
| `curl -s` / `-sS`               | `appstrate api -s` / `-sS`            | silence / silence-but-errors                      |
| `curl -f` / `--fail-with-body`  | same                                  | `-f` suppresses body; `--fail-with-body` keeps it |
| `curl -v`                       | `appstrate api -v`                    | `Authorization` always `[REDACTED]`               |
| `curl -w '%{http_code}\n'`      | `appstrate api -w '%{http_code}\n'`   | see write-out vars below                          |
| `curl --connect-timeout N`      | `appstrate api --connect-timeout N`   | exit 28 on timeout                                |
| `curl --max-time N`             | `appstrate api --max-time N`          | exit 28                                           |
| `curl --retry N`                | `appstrate api --retry N`             | 408/429/5xx; exp. backoff; Retry-After honored    |
| `curl --retry-connrefused`      | same                                  | off by default (matches curl)                     |
| `curl --compressed`             | `appstrate api --compressed`          | advertise gzip/deflate/br                         |
| `curl -r 0-1023`                | `appstrate api -r 0-1023`             | `Range: bytes=…`                                  |
| `curl -A 'UA'`                  | `appstrate api -A 'UA'`               | shortcut; `-H` still wins                         |
| `curl -e https://ref`           | `appstrate api -e https://ref`        | Referer shortcut                                  |
| `curl -b 'k=v'`                 | `appstrate api -b 'k=v'`              | literal only; cookie-jar files rejected           |

#### Write-out variables (`-w`)

Subset of curl's format string. Unknown variables pass through verbatim; `\n \r \t` escapes are expanded.

| Variable                | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `%{http_code}`          | Final response status (0 on connect failure)              |
| `%{http_version}`       | Hardcoded `1.1` — fetch() doesn't expose the real version |
| `%{size_download}`      | Body bytes received                                       |
| `%{size_upload}`        | Body bytes sent (0 when unknown — FormData / stream)      |
| `%{time_total}`         | Total time in seconds, 6 decimals                         |
| `%{time_starttransfer}` | Time until first response byte                            |
| `%{url_effective}`      | Final URL after redirects                                 |
| `%{num_redirects}`      | 1 if `-L` followed a redirect, else 0                     |
| `%{header_json}`        | Response headers as JSON                                  |
| `%{exitcode}`           | Our process exit code                                     |

#### Exit codes (libcurl-aligned)

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success                                                  |
| 1    | Generic / auth error                                     |
| 2    | Usage error (foreign host, `-G` + `-F`, cookie-jar path) |
| 6    | DNS failure (ENOTFOUND / EAI_AGAIN)                      |
| 7    | Connection refused / unreachable                         |
| 22   | HTTP ≥ 400 under `-f / --fail-with-body`                 |
| 25   | HTTP ≥ 500 under `-f / --fail-with-body`                 |
| 28   | `--max-time` or `--connect-timeout` expired              |
| 35   | TLS handshake failure                                    |
| 130  | SIGINT                                                   |

#### Differences from curl (intentional)

- **No `-u / --user`**: the whole point is that agents never see the bearer. Use `-H Authorization: …` if you really need to override (it's still `[REDACTED]` under `-v`).
- **Cross-origin `<url>` refused**: the bearer must not leave the profile's instance. Explicit exit 2 with a pointer at plain `curl`.
- **Cookie jars rejected**: `-b file.txt` is refused (exit 2). An attacker-controlled path would otherwise silently end up in the Cookie header.
- **No default `Content-Type`**: `-d` / `--data-urlencode` don't auto-set `application/x-www-form-urlencoded` the way curl does. Add `-H 'Content-Type: …'` explicitly when the server expects it (avoids corrupting multipart / binary payloads elsewhere in the API).

#### Behavioral divergences worth knowing

- **`%{http_version}` always reports `1.1`**: Web fetch doesn't expose the negotiated protocol. All other `-w` variables are accurate.
- **`%{header_json}` emits lowercase header names**: WHATWG fetch normalizes response header casing; curl preserves the wire casing. Parsers that key on lowercase are unaffected; case-sensitive parsers need adjustment.
- **`--connect-timeout` is wall-clock, not per-attempt under `--retry`**: the timer starts once at the first fetch and aborts the whole run if response headers haven't arrived. curl resets it per attempt. In practice this only differs when the first attempt partially succeeds then fails mid-body (rare); retries on DNS / network errors that never touch the socket are unaffected.
- **`--retry` disabled automatically on stdin bodies**: `-d @-`, `-T -`, `--data-urlencode @-` can't be replayed after the stream is consumed. The CLI warns on stderr and falls back to a single attempt instead of silently replaying an empty body.
- **`Retry-After` delta-seconds values capped at 1 hour**: server-suggested delays above 3600 seconds are ignored and fall back to exponential backoff. A hostile / misconfigured origin can't stall a CI job overnight.

## Profiles

Multiple Appstrate instances (dev / prod / a customer deploy / ...) can be kept side by side via named profiles. Resolution cascade (first match wins):

1. `--profile <name>` flag
2. `APPSTRATE_PROFILE` environment variable
3. `defaultProfile` key in `config.toml` (set on the first successful login)
4. Literal `"default"`

Each profile stores the instance URL + user identity in `~/.config/appstrate/config.toml` (TOML, `0600` perms); the session token lives in the OS keyring entry `(appstrate, <profile-name>)`.

```sh
# Sign into prod, pinned profile name
appstrate login --profile prod --instance https://app.example.com

# Make prod the default for future invocations
APPSTRATE_PROFILE=prod appstrate whoami
# → or edit defaultProfile in ~/.config/appstrate/config.toml
```

## Token storage

Tokens are stored in the OS keyring when available, otherwise in a file fallback.

| Platform | Primary backend                             | Fallback                                            |
| -------- | ------------------------------------------- | --------------------------------------------------- |
| macOS    | Keychain (via `@napi-rs/keyring`)           | `~/.config/appstrate/credentials.json` (`0600`)     |
| Linux    | libsecret / DBus (via `@napi-rs/keyring`)   | idem (triggers on stripped containers without DBus) |
| Windows  | Credential Manager (via `@napi-rs/keyring`) | idem                                                |

The fallback activates transparently when the keyring backend is missing (common in headless CI containers). A one-time stderr warning fires if the keyring backend reports a non-missing-backend error (corrupt DB, locked Keychain) — that way a legitimate misconfiguration doesn't silently degrade to plaintext storage.

## Configuration layout

```
$XDG_CONFIG_HOME/appstrate/              (or ~/.config/appstrate/)
├── config.toml                          # profiles, default profile pointer
└── credentials.json                     # keyring fallback (only if keyring unavailable)
```

Example `config.toml`:

```toml
defaultProfile = "prod"

[profile.prod]
instance = "https://app.example.com"
userId = "EWnC2cLyy88EpCGBa3WrIdS7uqI648BB"
email = "alice@example.com"
orgId = "org_123abc"

[profile.dev]
instance = "http://localhost:3000"
userId = "SVAA9PSXrmqQmg95A3RzyydtlravhhJR"
email = "dev@example.com"
```

`orgId` is optional — when set, every `apiFetch` request sends `X-Org-Id: <orgId>` so the instance scopes requests correctly. Unset means the user's default org applies server-side.

## Troubleshooting

**`Unauthorized — your session may have been revoked`**
Session expired or was revoked server-side. Re-run `appstrate login`.

**`This CLI is not registered on the target instance. The platform may be running an incompatible version.`**
The instance's `appstrate-cli` OAuth client is missing. Boot the platform — `ensureCliClient()` auto-provisions it on startup. If the instance is much older than the CLI (pre-Phase-1 device flow), the CLI binary is incompatible — downgrade via `APPSTRATE_VERSION=<older-tag> curl get.appstrate.dev | bash`.

**`Docker is required for this tier but was not found`**
`appstrate install --tier {1,2,3}` needs Docker. Install Docker Desktop (macOS) or the Docker engine (Linux) and re-run. On Windows, run inside WSL2 with the Docker engine installed in the WSL distro (Docker Desktop's WSL integration also works). Tier 0 doesn't need Docker.

**`Bun is not installed.`**
Tier 0 bootstrap couldn't find `bun` on PATH. The CLI offers to install it via the upstream `curl https://bun.sh/install | bash` (user-local, no sudo). Decline to install manually from [bun.sh](https://bun.sh/).

**Keyring fallback warning**
If you see `OS keyring ... failed ... falling back to ~/.config/appstrate/credentials.json`, the OS keyring is broken (libsecret unreachable on Linux, Keychain locked on macOS). The file fallback is `0600` but is plaintext — fix the keyring backend if you want secure-at-rest storage.

## Source + contributing

Source at [`apps/cli/`](../../apps/cli/). Tests at `apps/cli/test/` (unit tests, run with `bun test` from the CLI directory). E2E against a real instance: spin up an Appstrate Tier 0 with `bun run dev`, then `bun run src/cli.ts login --instance http://localhost:3000`.

### Building locally

`bun build --compile --target=bun-<host>` produces a working standalone binary for the **host platform** — `@napi-rs/keyring`'s native `.node` binding is resolved from `node_modules` at bundle time and embedded into the output.

**Cross-compiling from a single host does not work.** `bun build --compile --target=bun-linux-x64` from a macOS machine (or any other mismatched combination) will compile successfully but replace every `require("./keyring.<target>.node")` with a `throw new Error("Cannot require module …")`, because only the host-matching `@napi-rs/keyring-<platform>` optional dependency is installed by `bun install`. The binary will start, print `--help`, and crash the moment any code path touches the keyring (`login`, `logout`, `whoami`).

The release pipeline (`.github/workflows/release.yml`) handles this by running one job per target on a native runner (macOS arm64, macOS x64, Linux x64, Linux arm64) — each job's `bun install` fetches the matching native binding. If you need a binary for a platform other than your host locally, run `bun build --compile` on that target's OS or wait for a GitHub Release.

Architectural decisions in [ADR-006](../../docs/adr/ADR-006-cli-device-flow-monorepo.md); implementation plan in `docs/specs/CLI_IMPLEMENTATION_PLAN.md` (local-only, gitignored); preflight results in `docs/specs/cli-preflight-results.md` (also gitignored).
