# Appstrate CLI

`appstrate` is the official command-line tool for installing, configuring, and authenticating against an Appstrate instance. It is a single self-contained binary (Bun runtime embedded) — no Node.js, npm, or pre-installed dependencies required on the host.

Lives at [`apps/cli/`](./) in the monorepo; versioned in lockstep with the platform.

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

| Command               | Purpose                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `appstrate install`   | Install Appstrate locally (Tier 0) or bring up a Docker stack (Tiers 1/2/3).                                |
| `appstrate start`     | Start the installed Docker stack (`docker compose up -d`).                                                  |
| `appstrate stop`      | Stop the stack — containers off, volumes preserved.                                                         |
| `appstrate restart`   | Restart all containers.                                                                                     |
| `appstrate logs`      | Stream Compose logs (with `-f` and an optional service-name positional).                                    |
| `appstrate status`    | Show container status (`docker compose ps`).                                                                |
| `appstrate uninstall` | Tear down. Default keeps volumes; `--purge` wipes data + the install dir.                                   |
| `appstrate login`     | Sign into an instance via RFC 8628 device-flow. Tokens land in the OS keyring.                              |
| `appstrate logout`    | Revoke the active session server-side and wipe local credentials.                                           |
| `appstrate whoami`    | Print the identity attached to the active profile.                                                          |
| `appstrate token`     | Print metadata about the stored access + refresh tokens (debug).                                            |
| `appstrate org`       | List, switch, or create organizations pinned on the active profile.                                         |
| `appstrate space`     | List, switch, or create spaces pinned on the active profile.                                                |
| `appstrate skills`    | Sync the pinned space's skills to Claude Code and Codex as Agent Skills directories.                        |
| `appstrate api`       | Authenticated HTTP passthrough to the Appstrate API.                                                        |
| `appstrate openapi`   | Explore the active profile's OpenAPI schema without flooding stdout.                                        |
| `appstrate run`       | Execute an agent — a package id runs on the pinned instance, a `.afps`/`.afps-bundle` path runs in-process. |
| `appstrate runner`    | Install and manage the Firecracker runner daemon on a KVM host.                                             |

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

| Flag             | Values                | Description                                                                                                                                                                                                                                           |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-t`, `--tier`   | `0\|1\|2\|3`          | Skip the interactive tier prompt.                                                                                                                                                                                                                     |
| `-d`, `--dir`    | path                  | Install directory (default: `~/appstrate`).                                                                                                                                                                                                           |
| `--run-adapter`  | `docker\|firecracker` | Agent execution backend (default `docker`). `firecracker` runs each agent in a microVM on a KVM host running the appstrate-runner daemon; Docker tiers only. Also `APPSTRATE_RUN_ADAPTER`. Writes `RUN_ADAPTER` / `MODULES` / `FIRECRACKER_RUNNER_*`. |
| `--runner-url`   | url                   | Firecracker (remote): URL of an existing appstrate-runner daemon, e.g. `http://10.0.0.9:3100`. Implies the remote topology.                                                                                                                           |
| `--runner-token` | token                 | Firecracker: shared bearer token for the runner daemon (default: generate one).                                                                                                                                                                       |

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

### Lifecycle commands

After `appstrate install` (Tiers 1/2/3) every Compose verb has a thin
wrapper that reads the recorded project name from
`<dir>/.appstrate/project.json` — you never type the derived hash.

```sh
appstrate start                       # docker compose up -d (idempotent)
appstrate stop                        # docker compose stop (volumes intact)
appstrate restart                     # docker compose restart
appstrate logs -f                     # docker compose logs -f
appstrate logs -f postgres            # filter to a single service
appstrate status                      # docker compose ps
appstrate uninstall                   # docker compose down (data preserved)
appstrate uninstall --purge --yes     # destructive: down -v + rm -rf <dir>
```

**Flags (all subcommands)**

| Flag          | Description                                             |
| ------------- | ------------------------------------------------------- |
| `-d`, `--dir` | Override the install directory (default `~/appstrate`). |

**`appstrate logs`**

| Flag             | Description                                       |
| ---------------- | ------------------------------------------------- |
| `-f`, `--follow` | Stream new lines as they arrive.                  |
| `[service]`      | Optional positional — filter to a single service. |

**`appstrate uninstall`**

| Flag          | Description                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--purge`     | Also remove named volumes (Postgres, Redis, MinIO data) and the install directory. Destructive — prompts unless `--yes`.       |
| `-y`, `--yes` | Skip the destructive-action confirmation. Equivalent to `APPSTRATE_YES=1`. Required for `--purge` in non-interactive contexts. |

The raw `docker compose --project-name <hash> <verb>` form remains
supported — useful when you need a flag the wrapper doesn't expose.
The project name is in `~/appstrate/.appstrate/project.json`.

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
| `--create-org`    | `<name>`       | Create a new organization with this name and pin it. A default space + hello-world agent are provisioned server-side. Skips the prompt.       |
| `--no-org`        | —              | Skip the post-login org-pinning step entirely. Subsequent calls must carry `-H 'X-Org-Id: …'`, or pin later via `appstrate org switch`.       |
| `--space`         | `<id>`         | After the org pin, pin this space on the profile non-interactively. Fails if the reference does not match any space.                          |
| `--create-space`  | `<name>`       | Create a new space with this name after login and pin it. Skips the cascade's default-space pick.                                             |
| `--no-space`      | —              | Skip the post-login space-pinning step entirely. Subsequent calls must carry `-H 'X-Space-Id: …'`, or pin later via `appstrate space switch`. |

**Org pinning after login** (issue #209): on success, the CLI calls `GET /api/orgs` and branches:

- **Exactly one org** → auto-pin. The success banner names it: `Logged in as … to "Acme" (org_xxx)`.
- **Zero orgs** (fresh signup, dashboard onboarding skipped) → offer inline creation (`POST /api/orgs`) which also provisions a default space + hello-world agent server-side.
- **≥2 orgs** → interactive picker.

The pinned org id is written to `config.toml` and automatically sent as `X-Org-Id` on every subsequent `appstrate api` call, so `appstrate api GET /api/me` works immediately after a fresh login with no extra flags.

**Space pinning after login** (issue #217): after the org pin succeeds, the CLI cascades into `GET /api/spaces` and branches:

- **Exactly one space** → auto-pin.
- **≥2 spaces** → auto-pin the one with `isDefault: true` (the server provisions exactly one default per org). No interactive picker at login — use `appstrate space switch` afterwards for a different space.
- **No default among ≥2 spaces** (defensive — should never happen) → warn on stderr, leave unpinned.

On success, the banner names both: `Logged in as … to "Acme" (org_xxx) / space "Default" (spc_xxx)`. The pinned space id is sent as `X-Space-Id` on every `appstrate api` call, so space-scoped routes (`/api/agents`, `/api/runs`, `/api/schedules`, …) work with no extra flags.

**Flow** (what happens on the wire):

1. `POST /api/auth/device/code` → receive `device_code`, `user_code`, `verification_uri_complete`, `expires_in` (10 min), `interval` (5s).
2. CLI prints the code, opens the verification URI in the browser via the [`open`](https://www.npmjs.com/package/open) package (silent fallback on headless hosts — the URL is still displayed in the terminal).
3. User authenticates on the instance's `/activate` SSR page and clicks "Autoriser". A realm guard on `/device/approve` rejects cross-audience approval attempts (e.g. a space-level end-user trying to approve a CLI session).
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
appstrate logout --all                # nukes every CLI session (every device)
```

**Flags**

| Flag              | Values | Description                                                                                                                           |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`, `--profile` | name   | Profile to log out from (default: `default`).                                                                                         |
| `--all`           | —      | Revokes every CLI refresh-token family server-side via `POST /api/auth/cli/sessions/revoke-all`. Use after suspecting key compromise. |

If the instance is unreachable, local credentials are still wiped (with a warning on stderr) so the CLI returns to a clean state even during outages.

The dashboard's **Devices** preferences page (and `GET /api/auth/cli/sessions`) lets you revoke individual sessions. Org admins can revoke any member's CLI sessions via `GET/DELETE /api/orgs/:orgId/cli-sessions[/:familyId]` (requires the `cli-sessions:read|delete` RBAC grant — owners + admins by default).

---

### `appstrate self-update`

Channel-aware in-place upgrade. The binary stamps its install source at build time (`__APPSTRATE_INSTALL_SOURCE__`), so `self-update` knows whether it was installed via curl, Bun, or bunx and dispatches accordingly.

```sh
appstrate self-update                 # update to latest stable
appstrate self-update --release v1.2.3
appstrate self-update --force         # bypass version-equality short-circuit
```

| Flag              | Values  | Description                                   |
| ----------------- | ------- | --------------------------------------------- |
| `--release <tag>` | git tag | Pin the upgrade to a specific release.        |
| `-f`, `--force`   | —       | Re-install even if already on target version. |

- **curl channel** — downloads the new binary, verifies minisign + SHA-256, and atomically replaces `~/.local/bin/appstrate`.
- **bun channel** — refuses to overwrite, prints the matching `bun update -g @appstrate/cli` invocation.
- **unknown channel** — emits diagnostic instructions.

Channel matrix and recipes: [`docs/cli/upgrades.md`](../../docs/cli/upgrades.md).

---

### `appstrate doctor`

Diagnoses the local install: detects every `appstrate` on `$PATH`, deduplicates by realpath, prints version + channel + binary location for each. Use when `which -a appstrate` returns multiple results or when `self-update` reports an unexpected channel.

```sh
appstrate doctor                      # human-readable report
appstrate doctor --json               # machine-readable (for scripts / CI)
```

If a dual install is detected (e.g. curl-installed binary shadowed by a Bun-global one), the runtime warns once per realpath set; ack persisted at `~/.config/appstrate/dual-install-ack.json` re-arms whenever the set changes. Override with `APPSTRATE_FORCE_DUAL=1` to silence non-interactively.

A hidden `__install-source` subcommand exposes a stable JSON contract `{ version, source, schema: 1 }` for installers that need to gate on channel.

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

All four subcommands respect the global `--profile <name>` flag and talk to `GET /api/orgs` / `POST /api/orgs`. Creating an org server-side also provisions a default space + a hello-world agent, so the CLI lands on a fully-working setup with no extra steps.

**Subcommands**

| Subcommand              | Purpose                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `org list`              | List the orgs the active profile belongs to. The pinned one is marked with `*`.                                                          |
| `org switch [id\|slug]` | Re-pin the active org on the profile. With no argument, show an interactive picker with the current one highlighted.                     |
| `org current`           | Print the pinned org id to stdout. Exits 1 with a hint when no org is pinned — designed for `if` / shell prompts.                        |
| `org create [name]`     | Create a new org and pin it. With no argument, prompt for name + optional slug. Use `--slug <slug>` for an explicit kebab-case override. |

**Cascade — the space pin follows the org pin.** Every `org switch` / `org create` clears the current `spaceId` and re-pins the new org's default space in the same atomic operation. This keeps `appstrate api GET /api/agents` working immediately after switching — without the cascade the next call would return `404 Space '<id>' not found in this organization` (`apps/api/src/middleware/space-context.ts:159`) — the message the Troubleshooting section below indexes by.

---

### `appstrate space`

Manage the space pinned on the active profile. `login` auto-pins the default space in the pinned org (see above); `space switch` / `space create` let you change the pin without re-running the device flow. The pinned space id is sent as `X-Space-Id` on every `appstrate api` call — required for space-scoped routes (agents, runs, schedules, api-keys, notifications, packages, integrations, end-users, uploads, files). `/api/webhooks` is not one of them — it takes an explicit `spaceId` field instead.

```sh
appstrate space list            # enumerate spaces in the pinned org; pinned row is marked *, default row tagged [default]
appstrate space switch          # interactive picker (current space pre-highlighted)
appstrate space switch spc_xxx  # non-interactive — by id
appstrate space current         # print the pinned spaceId (scripts / shell prompts)
appstrate space create          # interactive (name) → auto-pin
appstrate space create "Staging"   # non-interactive → auto-pin
```

All four subcommands respect the global `--profile <name>` flag and talk to `GET /api/spaces` / `POST /api/spaces`. Spaces are identified by `id` only (there is no slug column server-side).

**Subcommands**

| Subcommand            | Purpose                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `space list`          | List the spaces in the pinned org. The pinned one is marked with `*`; the org's default is tagged `[default]`.         |
| `space switch [id]`   | Re-pin the active space on the profile. With no argument, show an interactive picker with the current one highlighted. |
| `space current`       | Print the pinned space id to stdout. Exits 1 with a hint when no space is pinned — designed for `if` / shell prompts.  |
| `space create [name]` | Create a new space and pin it. With no argument, prompt for a name interactively.                                      |

---

### `appstrate skills`

Materialize the skills installed in the pinned space as [Agent Skills](https://agentskills.io/specification) directories on this machine — one Claude Code plugin, and/or the shared skill directories Claude Code and Codex scan directly. The connected Claude Code plugin also configures the organization's Appstrate MCP server.

The command is designed to run **unattended**. Claude Code plugin marketplaces accept a `command` source: a locally installed tool prints the path of a directory holding a complete plugin, and Claude Code re-runs that command at install, then once per session in the background, reinstalling and reloading the plugin when the directory's content hash changes. That is the whole auto-sync mechanism — no hook, no daemon, no server-side change.

```sh
appstrate skills sync                                  # → the Claude Code plugin directory
appstrate skills sync --target codex                   # → ~/.agents/skills/
appstrate skills sync --target claude-user             # → ~/.claude/skills/
appstrate skills sync --target claude-plugin --target codex
appstrate skills sync --source draft                   # sync working copies instead of published versions
appstrate skills sync --dry-run                        # report what would change, write nothing
appstrate skills sync --print-path                     # the plugin path as the ONLY stdout line
```

**Subcommand and flags**

| Flag / subcommand | Purpose                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skills sync`     | The only subcommand. Reads the skills installed in the pinned space and writes one directory per skill into each requested target.                                                                                                                                                                     |
| `--target <name>` | Repeatable. `claude-plugin` (default) → `$XDG_DATA_HOME/appstrate/claude-plugin/`; `codex` → `~/.agents/skills/`; `claude-user` → `~/.claude/skills/`.                                                                                                                                                 |
| `--source <name>` | `published` (default) syncs each skill's `latest` published version, integrity-verified. `draft` syncs the working copy instead — for authors iterating on their own machine.                                                                                                                          |
| `--print-path`    | Print the plugin directory as the **only** stdout line; every message goes to stderr. This is what a marketplace `command` source consumes. Requires `--target claude-plugin`, and refuses `--dry-run`.                                                                                                |
| `--dry-run`       | Print the per-target plan and write nothing. One line per target with the counts (`+N` new, `~N` refreshed, `=N` unchanged, `-N` removed), then one line per affected slug: `+`, `~` or `-`. Cannot be combined with `--print-path`: a dry run produces no plugin, so there is no path worth printing. |

**Registering it with Claude Code.** Add the marketplace, then install the plugin — the consent screen shows the exact command string Claude Code will re-run each session:

```sh
appstrate login
claude plugin marketplace add appstrate/claude-plugins
claude plugin install appstrate@appstrate
```

The recorded command string is:

```
if command -v appstrate >/dev/null 2>&1; then exec appstrate skills sync --target claude-plugin --target codex --print-path; else exec npx -y appstrate@latest skills sync --target claude-plugin --target codex --print-path; fi
```

It must stay byte-stable: changing it stops the background re-runs until the user re-accepts via `claude plugin update`. Skills then appear as `/appstrate:<skill>`.

**Fresh machine.** Installing the plugin is the only step that has to come first. The command uses the installed CLI when there is one and `npx` otherwise, and `--print-path` on a machine whose profile is not configured (or has no org / space pinned) still succeeds: it installs a plugin whose only skill, `/appstrate:setup`, states what is missing and the exact command to run, plus a `SessionStart` hook that says so at every session start — to the user, and to Claude so it can offer to run `appstrate login` itself (the CLI opens the browser; the user only approves there; `login` pins the single organization and its default space by itself). The first connected sync replaces that skill with the organization's. This only happens on a fresh plugin: once skills have been synced, a lapsed login fails the run and leaves the installed plugin untouched.

**MCP connection.** A connected sync writes this `.mcp.json` at the plugin root, using the profile's instance and pinned organization:

```json
{
  "mcpServers": {
    "appstrate": {
      "type": "http",
      "url": "https://app.example.com/api/mcp/o/org_123abc"
    }
  }
}
```

It contains no headers or tokens. The setup plugin has no MCP configuration. In Claude Code, open `/mcp`, select `plugin:appstrate:appstrate`, and complete the browser OAuth flow if authentication is needed. This login is separate from `appstrate login`; the CLI's keyring session is never copied into the plugin. Tools use names such as `mcp__plugin_appstrate_appstrate__search_operations`. [Claude Code plugin MCP reference](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers).

**Space selection matters.** Skills come from the CLI's pinned space; MCP uses the organization's **default space**, because the generated connection sends no `X-Space-Id`. For example, pinning space B while A is the default loads B's skills but executes space-scoped MCP operations in A. Run `appstrate space list` to see the default and `appstrate space current` to check the pin. Use `appstrate api` for operations in the pinned space when it differs; switching the CLI's space does not change the MCP connection.

**Upgrading or switching organizations.** The first sync after this CLI upgrade changes the plugin's content hash even if the skills are unchanged. Switching instance or organization also rewrites its endpoint. To apply it immediately:

```sh
appstrate org switch <id-or-slug>        # when changing organizations
claude plugin update appstrate@appstrate # re-runs the default-profile sync
```

Then exit the active Claude Code session and start a new one, check the endpoint in `/mcp`, and authenticate for the new endpoint if requested before running an operation. Use this restart sequence for the first MCP upgrade too. Do not rely on `/reload-plugins` alone to switch organizations or instances: the active connection can retain the previous endpoint. For a different instance, connect the marketplace's default CLI profile to it with `appstrate login --instance <url>` first. A one-off sync with `--profile` is replaced by the default profile on the next marketplace refresh. The exact prompts depend on Claude Code's version, saved approvals and enterprise settings; a plugin update is not proof that OAuth or the endpoint switch succeeded. [Plugin component lifecycle](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution).

**Existing MCP connections and opt-out.** A manually configured `appstrate` server can coexist with the plugin server and expose another set of tools. Check their endpoints in `/mcp` and disable the connection you do not want; sync never removes your manual configuration. To keep the skills without the plugin's MCP connection, toggle `plugin:appstrate:appstrate` off in `/mcp` for the current project. [Disabling a server](https://code.claude.com/docs/en/mcp#disable-a-server-without-removing-it). Administrators can restrict the endpoint with `allowedMcpServers` / `deniedMcpServers` URL rules, or match the scoped server name `plugin:appstrate:appstrate` rather than the bare `appstrate` key. [Managed MCP configuration](https://code.claude.com/docs/en/managed-mcp).

**What lands in a skill directory.** Every file of the published artifact except `manifest.json` and `RECORD` (Appstrate packaging, not skill content), with one rewrite in `SKILL.md`: the frontmatter `name` is pointed at the directory name when it differs, because the spec requires the two to match. Nothing else is touched — no description is invented, no key is reordered. The output is deterministic — no timestamps, no sync metadata — because a `mode: "copy"` plugin's version _is_ the hash of its contents.

Appstrate refuses to publish a skill whose frontmatter is not valid Agent Skills YAML, but artifacts published before that rule existed are still synced exactly as authored. Each one is named once on stderr (`… does not pass the skill frontmatter rule …`): Claude Code and Codex may skip it, and the fix is to republish it from Appstrate.

**Directory names.** The Agent Skills spec requires the frontmatter `name` to equal the parent directory name, and Appstrate ids are `@scope/name`, which is not a legal skill name. The directory is therefore the frontmatter `name` when it is already legal, falling back to the slugified package `name` segment. If two skills in the space claim the same slug, the second one — ordered by package id, so the choice is reproducible — becomes `<scope>-<name>`, then `<scope>-<name>-2`, `-3`, … until the name is free. Every rename is reported on stderr.

**Failure modes.** The command never prompts and never assumes a TTY. Each of these is a _whole-run_ failure: it exits 1 with a one-line remedy on stderr, which Claude Code surfaces under `/plugin` → Errors. The first, third and fourth rows become the `/appstrate:setup` plugin instead under `--print-path` on a fresh plugin (see above).

| Condition                                                   | stderr                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Not logged in (or profile not configured)                   | `Profile "default" not configured. Run: appstrate login --profile default`                  |
| Refresh token expired / session revoked                     | `Session for profile "default" is no longer valid … Run: appstrate login --profile default` |
| No organization pinned                                      | `No organization pinned. Run: appstrate org switch`                                         |
| No space pinned                                             | `No space pinned. Run: appstrate space switch`                                              |
| `--print-path` without the plugin target                    | `--print-path prints the Claude Code plugin directory. Add: --target claude-plugin`         |
| `--print-path` together with `--dry-run`                    | `--print-path cannot be combined with --dry-run: a dry run writes no plugin.`               |
| The catalogue call, a target write or the state file failed | the underlying error                                                                        |

**Per-skill failures are graded differently under `--print-path`.** A skill that was never published, whose bytes do not match the server's `X-Integrity`, or whose destination is not ours is reported on stderr and skipped; the rest of the sync completes.

- Without `--print-path`, the command then exits 1 so a wrapper notices.
- With `--print-path`, it exits **0** as long as the plugin tree itself was written (or was already up to date), and prints the path. A non-zero exit makes Claude Code discard the run, so failing the process over one unpublished skill would throw away a correct plugin. When the plugin tree could _not_ be produced, nothing is printed on stdout and the command exits 1.

A skill whose refresh fails keeps the version already on disk and its state entry is preserved — a failed download never deletes a working skill. The same holds one step earlier: **deletion is decided against the catalogue, not against what resolved.** A skill the server still lists but whose version could not be read (a 500, a 429, an expired token mid-run) is kept exactly as it is, counted among the unchanged; only a skill that has genuinely left the catalogue is removed. Its directory name stays reserved for it too, so a transient error cannot hand `/appstrate:<slug>` to a different skill.

**Deleting, and not overwriting.** `codex` and `claude-user` write into directories you also fill by hand. The sync only ever removes — or replaces — a directory its own state file records as managed for that target. A destination it does not own is left completely alone and reported:

```
Skipped @acme/pdf-tools on codex: /home/you/.agents/skills/pdf-tools exists and is not managed by appstrate — remove or rename it
```

There is no automatic rename: remove or rename the directory yourself and re-run. While a sync is in flight, staging happens under a dot-prefixed `.appstrate-staging/`, so neither Claude Code nor Codex can pick up a half-written skill. Concurrent syncs (two Claude Code sessions opening together) are serialized by a lock under `skills-sync/`; it records its owner's pid and is reaped as soon as that process is gone, so a sync killed mid-run never blocks the next one.

Ownership is recorded per target **together with the root it was written under**. `HOME` is not a constant — the same profile run from cron, `launchd`, `sudo -E` or a devcontainer can resolve a different `~/.agents/skills` — so a state file whose recorded root does not match the current one is read as claiming nothing. Every directory it finds is then treated as unmanaged: refused, never overwritten.

#### Codex, and running without a Claude Code plugin

The recorded marketplace command syncs both targets (`--target claude-plugin --target codex`), so if you use Claude Code, every session already refreshes `~/.agents/skills/` and Codex picks the skills up on its next start. This target supplies skills only; it does not configure Codex MCP.

**Connect Codex manually.** Run `appstrate whoami` to read the instance URL, `appstrate org list` to choose an organization, and `appstrate org current` to print its pinned ID. Substitute those values below, removing any trailing slash from the instance URL:

```sh
codex mcp get appstrate                   # inspect any existing entry first
# If no entry exists:
codex mcp add appstrate --url https://app.example.com/api/mcp/o/org_123abc
codex mcp login appstrate
```

If `appstrate` already names the intended endpoint, keep its configuration and log in only if needed. If it names something else, use a distinct name such as `appstrate-acme` in both commands to preserve the existing connection. On an organization or instance switch, update only the intended entry's `url` under `[mcp_servers.<name>]` in `~/.codex/config.toml`, preserving its other settings, then run `codex mcp login <name>`, restart Codex and verify `/mcp` before using it. Skill sync does not update this URL or share the CLI's login. The same default-space behavior described above applies. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For Claude Code without the plugin, use the same instance and organization with an explicit user scope, then authenticate through `/mcp`:

```sh
claude mcp add --transport http --scope user appstrate https://app.example.com/api/mcp/o/org_123abc
```

Inspect an existing entry with `claude mcp get appstrate` before adding; keep it or choose another name rather than replacing it blindly. [Claude Code installation scopes](https://code.claude.com/docs/en/mcp#user-scope).

Two cases need you to run the sync yourself: you do not use Claude Code at all, or your organization blocks command-sourced plugins (`disableCommandPluginSources`). Then schedule `appstrate skills sync --target codex` (add or swap in `--target claude-user` to feed `~/.claude/skills/`, which Claude Code picks up live).

A cron entry every 15 minutes — cron's `PATH` is minimal, so give the absolute path:

```cron
*/15 * * * * /usr/local/bin/appstrate skills sync --target codex >/dev/null 2>&1
```

On macOS, prefer a `launchd` user agent running the same command every 900 seconds (`command -v appstrate` gives the absolute path).

**The scheduler must reach your OS keyring.** The sync reads the profile's token from the keyring, and a keyring is bound to a session, not to a user id: a `launchd` **user agent** runs inside your logged-in session and can unlock the login keychain, while a system cron job (or anything under `sudo`) may not — the sync then fails with the "not logged in" remedy even though you are. That is why `launchd` is the recommended path on macOS. Remember that `HOME` differs per context too: a scheduler resolving a different `~/.agents/skills` than your shell does gets a state file that claims nothing, and every directory there is refused rather than overwritten.

Per-skill toggles survive all of this. We never write `~/.codex/config.toml`, and directory names are stable across syncs, so a `[[skills.config]]` block disabling one of the synced skills keeps applying to the same skill after the next sync.

---

### `appstrate openapi`

Explore the active profile's OpenAPI 3.1 schema without dumping the whole spec to stdout. The platform exposes a few hundred endpoints — `list`, `show`, and `export` subcommands make that corpus explorable at human scale (and agent-ingestable with `--json`).

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

Curl-like authenticated HTTP passthrough. Purpose-built so coding agents (Claude Code, Cursor, Aider, …) can call the Appstrate API in a shell-one-liner without ever seeing the raw bearer — the CLI injects `Authorization: Bearer …` + `X-Org-Id` + `X-Space-Id` from the keyring-backed profile.

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
| `curl -L`                       | `appstrate api -L`                    | cross-origin: `Authorization` dropped, `-H` kept  |
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

**About `-L`.** A `Location` is chosen by the server and is never re-validated against your profile origin, so following it is opt-in. On a cross-origin hop the runtime drops `Authorization` and `Cookie`, but every custom `-H` header you pass — plus `X-Org-Id` / `X-Space-Id` — is forwarded to that host. Don't pass a second credential via `-H` and assume `-L` is safe. Without `-L`, a 3xx is surfaced un-followed (usually an empty body, exit 0) and the CLI prints a hint on stderr naming the `Location`.

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

### `appstrate run`

Execute an agent. The shape of the target picks the execution mode:

- **By package id** — `@scope/agent[@spec]`. Runs **remotely** by default: the CLI POSTs `/api/agents/{scope}/{name}/run` on the pinned instance (the same path as the dashboard "Run" button), then tails the run's logs and final status. Pass `--local` to run the agent in-process instead — the CLI then calls `GET /api/agents/{scope}/{name}/bundle` to download a deterministic `.afps-bundle`, verifies its SRI integrity in memory, and runs it via the Pi runner. The bytes are never written to disk — every invocation re-fetches.
- **By file path** — a local `.afps` or `.afps-bundle` file. Runs **locally**, in-process via the Pi runner, with the caller's shell, FS, and env. No network roundtrip for the bundle. `--remote` is rejected on a path target: the CLI does not upload local bundles to the instance.

`--local` and `--remote` are mutually exclusive.

```sh
# Run the latest version of an installed agent
appstrate run @scope/triage

# Pin an exact version
appstrate run @scope/triage@1.2.0

# Resolve via dist-tag
appstrate run @scope/triage@beta

# Run a local bundle without hitting the instance
appstrate run ./out/triage-1.2.0.afps-bundle --integrations local --creds-file ./creds.json
```

Run-config inheritance (model, proxy, version pin) is fetched from `/api/spaces/{spaceId}/packages/{scope}/{name}/run-config` and merged with flag/env overrides. Use `--no-inherit` to opt out (deterministic CI).

Agent parameters are supplied with `--input <json>` / `--input-file <path>`. Remote runs send your input verbatim — the instance resolves and validates it server-side. A **local** run reaches none of the server's code, so the CLI reproduces the same chain in-process:

1. **Author defaults** — the `default` keywords in the agent's own `input` schema, always.
2. **Stored per-space values** — `space_packages.input_settings.values`, i.e. what the dashboard's agent settings hold. Applied only when the target is a package id (`appstrate run @scope/agent`) and inheritance is on; a bundle read off disk has no space row behind it and stays on author defaults alone. `--no-inherit` skips this layer.
3. **Your `--input` / `--input-file`** — wins over both, including an explicit `null` or `""`. Only an _absent_ key falls through to a lower layer.

A field the editor **locked** cannot be set at launch: naming it in `--input` / `--input-file` is a hard error (`Field '<name>' is locked on this agent and cannot be set at launch`), not a silently dropped value — the same rule the server's `locked_input_field` enforces. Leave it out and the stored value applies.

The resolved result is then validated against the agent's `input` schema before anything executes, through the same validator the platform uses. A required field answered by no layer, or a value of the wrong type, exits non-zero with the offending field named rather than reaching the agent as an empty render.

**Remote runs and process lifetime**

A remote run executes on the instance and outlives the CLI process by design — like closing a dashboard tab. What `SIGINT` / `SIGTERM` / `SIGHUP` does to that run depends on whether a human sent it:

- **Interactive** (stdin is a TTY and `--json` is not set) — the signal **cancels** the run server-side (`POST /api/runs/{runId}/cancel`) and the CLI keeps polling until the run reaches a terminal status, so the final state still prints. Ctrl-C at a keyboard is a cancel intent.
- **Non-interactive** (`--json`, or stdin is not a TTY: CI, a supervisor, a background shell) — the signal **detaches**. No cancel is sent, the CLI stops tailing, and the run keeps going:

```
detached — run run_9c1e4f2a is still running on https://app.example.com
  follow it with: appstrate api GET /api/runs/run_9c1e4f2a
```

Under `--json` the detach is a single JSONL envelope on stdout instead: `{"type":"appstrate.remote.detached","runId":"…","instance":"…"}`. A detached run has no terminal status, so the CLI writes no `--output` file and prints no `[run complete]` / `[run failed]` line — a fabricated status would be worse than a missing one.

`--cancel-on-exit` / `--no-cancel-on-exit` force either behaviour and take precedence over both auto-rules. They are remote-only: passing either one on a local run is an error, not a silent no-op — an in-process run dies with the CLI and there is nothing to detach from.

Exit codes on the signal path are the conventional POSIX ones (128 + signal number), in both the cancel and the detach case: `130` for SIGINT, `143` for SIGTERM, `129` for SIGHUP.

**Selected flags**

| Flag                    | Purpose                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--proxy <id>`          | Proxy id to associate with the run (overrides the per-space inherited value).                                                                                                                                                                                |
| `--[no-]cancel-on-exit` | Remote runs only: whether SIGINT/SIGTERM/SIGHUP cancels the platform-side run. Default: on when stdin is a TTY and `--json` is not set (interactive Ctrl-C cancels), off otherwise — the CLI detaches and the run keeps going, like closing a dashboard tab. |
| `--no-inherit`          | Skip per-space run-config inheritance — flags + env vars + defaults only.                                                                                                                                                                                    |
| `--json`                | Emit canonical RunEvents as JSONL on stdout.                                                                                                                                                                                                                 |
| `-v, --verbose`         | Verbose tool-call output: pretty-print args + reveal full results (~2 KB). Honoured only in human mode (without `--json`). Env: `APPSTRATE_VERBOSE=1`.                                                                                                       |
| `-q, --quiet`           | Suppress per-tool output lines (name, args, result). Errors and final summary still print. Mutually exclusive with `--verbose`.                                                                                                                              |

**Tool-call rendering**

In human mode (no `--json`), each tool call surfaces as one to three lines:

```
→ tool: bash
  args  command: "ls -la /tmp", timeout: 5000
✓ result total 8 ↵ drwxr-xr-x 3 root ...
```

Defaults match the dashboard log viewer: args truncated at 200 chars, result preview at 100 chars (newlines collapsed to `↵`). Pass `-v` to pretty-print args as multi-line JSON and reveal the full ~2 KB result; pass `-q` to suppress tool lines entirely (errors + summary always print). The bridge truncates oversized results to ~2 KB before transport — a `__truncated: true` marker stays visible in either mode so silent data loss is impossible.

The full flag set is documented under `appstrate run --help`.

**Connection readiness**

Connection readiness is enforced server-side at run-trigger time: a run that targets an integration without a healthy connection is rejected with HTTP 412 (`missing_integration_connection`) before the container launches. Connect or repair the connection from the dashboard's connectors panel (`${instance}/preferences/connectors`).

---

### `appstrate runner`

Install and manage the **Firecracker runner daemon** (`appstrate-runner`) on a KVM host. The daemon owns the privileged surface — KVM, TAP devices, nftables — and boots one microVM per run; the containerized platform stays a thin HTTP client (`RUN_ADAPTER=firecracker`, `FIRECRACKER_RUNNER_URL`/`_TOKEN`). This is the same control-plane / host-daemon split AWS, Fly.io, and E2B use. Architecture: [`../../docs/architecture/FIRECRACKER.md`](../../docs/architecture/FIRECRACKER.md).

Runs on a Linux KVM host (not macOS). Requires `/dev/kvm` and root (systemd).

```sh
appstrate runner install --platform-url http://10.0.0.5:3000   # preflight + install + start via systemd
appstrate runner doctor                                         # preflight + systemd state + daemon health + artifacts version
appstrate runner doctor --json                                  # machine-readable
appstrate runner update                                         # re-download the daemon for this CLI's version, verify, swap, restart
appstrate runner status                                         # systemctl status appstrate-runner
appstrate runner logs -f                                        # journalctl -u appstrate-runner
```

**`appstrate runner install` flags**

| Flag             | Description                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| `--platform-url` | IPv4 URL the guests reach the platform on (e.g. `http://10.0.0.5:3000`).              |
| `--token`        | Shared bearer token (default: preserve existing, else generate one).                  |
| `--port`         | Daemon listen port (default: `3100`).                                                 |
| `--data-dir`     | State root for kernel/rootfs/runs/firecracker (default: `/var/lib/appstrate-runner`). |
| `--host`         | Daemon bind address (default: `0.0.0.0`).                                             |
| `-y`, `--yes`    | Skip prompts (requires `--platform-url`).                                             |

Point the platform at the daemon by setting `RUN_ADAPTER=firecracker`, adding `firecracker` to `MODULES`, and exporting `FIRECRACKER_RUNNER_URL` / `FIRECRACKER_RUNNER_TOKEN` — or pass `--run-adapter firecracker` to `appstrate install`, which writes these for you.

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

$XDG_DATA_HOME/appstrate/                (or ~/.local/share/appstrate/)
├── claude-plugin/                       # generated Claude Code plugin (`appstrate skills sync`)
├── skills-sync/state.json               # which skill directory each target owns, and from which artifact
└── skills-sync/sync.lock                # flock(2) target serializing concurrent syncs (never removed)
```

`skills-sync/state.json` lives outside every target tree on purpose: the generated plugin's version is the hash of its contents, so a state blob inside it would make each sync look like a new plugin version. It is also the only record of which directories in the shared `~/.agents/skills/` and `~/.claude/skills/` belong to the sync.

**Deleting it does not reset the sync — it locks it out of the shared targets.** The plugin directory is rebuilt from scratch (it is wholly ours), but every directory already sitting in `~/.agents/skills/` and `~/.claude/skills/` becomes unmanaged: the sync can no longer prove it wrote them, so it refuses to overwrite or delete them and reports each one. Removing those directories by hand is what un-sticks it. The file also carries a format version; a sync from a CLI whose materialization changed treats every entry as stale and re-materializes, without giving up ownership.

Example `config.toml`:

```toml
defaultProfile = "prod"

[profile.prod]
instance = "https://app.example.com"
userId = "EWnC2cLyy88EpCGBa3WrIdS7uqI648BB"
email = "alice@example.com"
orgId = "org_123abc"
spaceId = "spc_abc123"

[profile.dev]
instance = "http://localhost:3000"
userId = "SVAA9PSXrmqQmg95A3RzyydtlravhhJR"
email = "dev@example.com"
```

`orgId` and `spaceId` are both optional — when set, every `apiFetch` request sends `X-Org-Id: <orgId>` (and `X-Space-Id: <spaceId>`) so the instance scopes requests correctly. Unset `orgId` means the user's default org applies server-side; unset `spaceId` means space-scoped routes (`/api/agents`, `/api/runs`, …) return `400 Space context required` and the caller must pass `-H X-Space-Id: …` manually.

A profile written by an older CLI carries an `applicationId` key instead of `spaceId`. That name is retired: the CLI refuses to run rather than silently dropping the value on the next write. Delete the line and re-pin with `appstrate space switch` — the old value was an `app_…` id and spaces are `spc_…`, so it could not have been carried over anyway.

## Troubleshooting

**`Unauthorized — your session may have been revoked`**
Session expired or was revoked server-side. Re-run `appstrate login`.

**`Space context required. Provide X-Space-Id header or use an API key.`**
The pinned profile has no `spaceId`. Either the cascade at login skipped it (`--no-space`, zero spaces in the org, or no default found), or a previous `org switch` cleared it and the re-pin fetch flaked. Run `appstrate space switch` to pick one, or pass `-H 'X-Space-Id: …'` on the call.

**`Space '<id>' not found in this organization`**
The pinned `spaceId` belongs to a different org than the currently pinned `orgId`. Happens when something mutates `config.toml` between an `org switch` and the next API call, or after a manual hand-edit. Run `appstrate space switch` to re-pin a valid space under the current org.

**`Profile "<name>" in <path> was written by an older Appstrate CLI: it pins the retired key "applicationId" …`**
`applicationId` was renamed to `spaceId`. The old key is refused rather than read, so the pin is never silently erased from `config.toml`. Delete the `applicationId = …` line from the profile section, then run `appstrate space switch` to re-pin. The refusal fires on any profile in the file, not just the active one — every command reads the whole config.

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
