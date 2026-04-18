# Appstrate CLI

`appstrate` is the official command-line tool for installing, configuring, and authenticating against an Appstrate instance. It is a single self-contained binary (Bun runtime embedded) — no Node.js, npm, or pre-installed dependencies required on the host.

Lives at [`apps/cli/`](./) in the monorepo; versioned in lockstep with the platform ([ADR-006](../../docs/adr/ADR-006-cli-device-flow-monorepo.md)).

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

| Flag              | Values | Description                                                   |
| ----------------- | ------ | ------------------------------------------------------------- |
| `--instance`      | URL    | Instance base URL. Skips the interactive prompt.              |
| `-p`, `--profile` | name   | Profile name to store credentials under (default: `default`). |

**Flow** (what happens on the wire):

1. `POST /api/auth/device/code` → receive `device_code`, `user_code`, `verification_uri_complete`, `expires_in` (10 min), `interval` (5s).
2. CLI prints the code, opens the verification URI in the browser via the [`open`](https://www.npmjs.com/package/open) package (silent fallback on headless hosts — the URL is still displayed in the terminal).
3. User authenticates on the instance's `/activate` SSR page and clicks "Autoriser". A realm guard on `/device/approve` rejects cross-audience approval attempts (e.g. an application-level end-user trying to approve a CLI session) — see [ADR-006](../../docs/adr/ADR-006-cli-device-flow-monorepo.md) for rationale.
4. CLI polls `POST /api/auth/device/token` every `interval` seconds (honoring `slow_down` backoff) until approval. On success: receives `access_token` (a raw Better Auth session token, not a JWT).
5. CLI calls `/api/auth/get-session` with `Authorization: Bearer <token>` to fetch the canonical identity.
6. Session token is stored in the OS keyring; profile is written to `config.toml`.

**Session lifetime**: 7 days (Better Auth session default). No refresh token — re-run `appstrate login` when the session expires. The CLI surfaces an `AuthError` with a re-login hint on 401 responses.

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

Prints the identity attached to a profile by calling `/api/auth/get-session` with the stored token.

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
