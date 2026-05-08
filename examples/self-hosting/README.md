# Self-Hosting

Deploy Appstrate via the official `appstrate` CLI, or manually with
Docker Compose. This directory holds the production `docker-compose.yml`
(the Tier 3 full stack: PostgreSQL + Redis + MinIO) plus progressive
`docker-compose.tier{1,2,3}.yml` templates used by `appstrate install`.

## One-Liner Install (Recommended)

```bash
curl -fsSL https://get.appstrate.dev | bash
```

This downloads + cryptographically verifies the `appstrate` CLI binary
for your OS/arch, drops it on PATH, and prints a copy-pasteable next
step. **The install itself is a separate command:**

```bash
appstrate install
```

Why two steps? Running `install` from your real interactive shell gives
you the full clack-style prompts (tier picker, install dir, port, owner
email) and sidesteps a Bun macOS regression (#199, oven-sh/bun #6862,
#7033, #24615) that hangs interactive prompts when launched under
`curl|bash`. The two-step pattern is the same one Supabase, Vercel,
Railway, gh CLI, and fly.io use.

Press Enter at the tier prompt to land on the recommended Tier 3 stack:

- **Tier 3** — Postgres + Redis + MinIO (full production, **default**)
- **Tier 2** — Postgres + Redis (no object storage)
- **Tier 1** — Postgres only (dev / testing)
- **Tier 0** — Bun + PGlite + filesystem (no Docker, hobby / evaluation)

If Docker is not detected on your machine the CLI automatically falls
back to Tier 0 as the highlighted default.

`appstrate install` generates cryptographic secrets, writes `.env` +
`docker-compose.yml`, runs `docker compose up -d`, waits for the
healthcheck, and opens http://localhost:3000 in your browser.

### Managing the stack post-install

Once installed, the lifecycle commands manage the stack from any
working directory — they read the Compose project name from
`<dir>/.appstrate/project.json` so you never have to remember the
derived hash:

```bash
appstrate start           # docker compose up -d
appstrate stop            # docker compose stop (volumes preserved)
appstrate restart         # docker compose restart
appstrate logs -f         # docker compose logs -f
appstrate logs postgres   # filter to a single service
appstrate status          # docker compose ps
appstrate uninstall       # docker compose down (containers gone, data preserved)
appstrate uninstall --purge   # destructive: down -v + rm -rf <dir>
```

All commands accept `--dir <path>` to target a non-default install
directory. `--purge` prompts for confirmation unless `--yes` (or
`APPSTRATE_YES=1`) is set; the prompt enumerates exactly what gets
destroyed (Postgres / Redis / MinIO data + the install dir).

If you prefer the raw form (e.g. for scripting against a specific
flag the wrapper doesn't expose):

```bash
docker compose --project-name "$(jq -r .projectName ~/appstrate/.appstrate/project.json)" <verb>
```

### Unattended install (CI / cloud-init / Ansible)

```bash
curl -fsSL https://get.appstrate.dev | bash -s -- --yes
```

The `--yes` flag fires the legacy all-in-one path: download + verify +
exec `appstrate install --yes` in a single command. **Closed-by-default
semantics apply (#344):** when no `APPSTRATE_BOOTSTRAP_OWNER_EMAIL` is
provided, the installer generates a single-use `AUTH_BOOTSTRAP_TOKEN`,
ships the instance with `AUTH_DISABLE_SIGNUP=true`, and prints a banner
with the redemption URL. Open `<APP_URL>/claim`, paste the token plus
your owner email/password — the instance is yours.

Want to skip the redemption step entirely? Pre-set the bootstrap email:

```bash
APPSTRATE_BOOTSTRAP_OWNER_EMAIL=admin@example.com \
  curl -fsSL https://get.appstrate.dev | bash -s -- --yes
```

Now the bootstrap owner signs up at `/register` (form pre-fills + locks
the email field) — see [AUTH_MODES.md](./AUTH_MODES.md) for the full
matrix of closed-mode options.

Legacy `APPSTRATE_AUTO_INSTALL=1` is preserved as an escape hatch for
existing scripted provisioning that depended on the previous "always
auto-install" default.

Overrides: `APPSTRATE_VERSION=v1.2.3` (env var pins a specific release
binary). Per-field flags: `bash -s -- --tier 3 --dir ~/appstrate`.

To upgrade, re-run the same command with the new tag — `APPSTRATE_VERSION`
controls which CLI binary is downloaded.

## Verifying the Installer

The one-liner above relies on TLS + GitHub Pages. For stronger guarantees, two supply-chain mechanisms are available:

### Option 1 — SLSA build provenance (GitHub OIDC + Sigstore)

Every published `install.sh` is signed via GitHub's OIDC token and attested through Sigstore's transparency log. Verify with the GitHub CLI:

```bash
curl -fsSLo install.sh https://get.appstrate.dev/install.sh
gh attestation verify install.sh --owner appstrate
bash install.sh
```

No key management required — trust is anchored in GitHub's identity system.

### Option 2 — Minisign offline signature

Current signing key:

- Fingerprint: `1EF2FF084226C4FA`
- Public key: `RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e`

The pubkey is committed at [`scripts/appstrate.pub`](../../scripts/appstrate.pub) for cross-channel verification — if you don't trust `get.appstrate.dev`, fetch it from the repo instead.

Verified one-liner (wraps download → verify → run):

```bash
curl -fsSL https://get.appstrate.dev/verify.sh | bash
```

Or manually:

```bash
curl -fsSLo install.sh         https://get.appstrate.dev/install.sh
curl -fsSLo install.sh.minisig https://get.appstrate.dev/install.sh.minisig
curl -fsSLo appstrate.pub      https://get.appstrate.dev/appstrate.pub

minisign -Vm install.sh -p appstrate.pub
less install.sh                # optional: read before running
bash install.sh
```

### Maintainer: key rotation

The signing keypair for `1EF2FF084226C4FA` is already provisioned. Rotate only if the private key is compromised or as a periodic hygiene measure. Procedure:

1. **Generate a new keypair** (offline, on a trusted machine):

   ```bash
   minisign -G -p appstrate.pub -s appstrate.key
   ```

   Choose a strong passphrase. Back up `appstrate.key` in a password manager or hardware token.

2. **Single atomic PR** — updating the pubkey and the GitHub secrets non-atomically breaks signature verification between the two actions:
   - Commit `appstrate.pub` to `scripts/appstrate.pub` (replacing the previous content)
   - Update the `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` repository secrets in the `appstrate/appstrate` repo settings
   - Update the fingerprint and public key value in this document

3. **Cut a new tag** — `publish-installer.yml` re-signs `install.sh` with the new key and publishes `install.sh.minisig` + `appstrate.pub`.

4. **Announce the rotation** in the release notes. Previously-released installer versions remain verifiable against the retired pubkey via their versioned URL (`https://get.appstrate.dev/vX.Y.Z/install.sh.minisig`) — users pinned to older versions need to fetch the old pubkey or upgrade.

## Prerequisites

- Docker Engine 20+ with Compose V2
- At least 4 GB of available RAM
- Docker socket accessible at `/var/run/docker.sock` (required for agent runs)

## Docker Network Pool Tuning

Appstrate is network-heavy by design: the stack creates a few long-lived
networks at boot (`appstrate-data`, `appstrate-public`,
`appstrate-egress`, `appstrate-sidecar-pool`) and allocates one isolated
bridge network per agent run (`appstrate-exec-<runId>`). On a host that
already runs several Docker projects, that pressure is often enough to
exhaust Docker's **default address pool** and produce:

```
Docker create network appstrate-exec-… failed: 400
{"message":"all predefined address pools have been fully subnetted"}
```

This is a host-side limit, not a bug in Appstrate. Docker's default
configuration splits `172.17.0.0/12` into `/16` subnets, which caps the
whole host at ~31 user-defined networks.

**Diagnose**:

```bash
docker network ls --format '{{.Name}}' | wc -l
```

**Quick fix** — reclaim unused networks:

```bash
docker network prune
```

**Permanent fix** — carve smaller subnets so the host can hold hundreds
of networks. Edit Docker's daemon configuration:

- **Linux**: `/etc/docker/daemon.json`
- **macOS / Windows**: Docker Desktop → Settings → Docker Engine

```json
{
  "default-address-pools": [
    { "base": "172.20.0.0/16", "size": 24 },
    { "base": "10.200.0.0/16", "size": 24 }
  ]
}
```

Then restart the Docker daemon (`sudo systemctl restart docker` on
Linux; "Apply & Restart" in Docker Desktop). Each `/16` base yields
~256 networks at `size: 24`, so two pools give ~512 slots — ample
headroom for a busy Appstrate host. Docker consumes pools sequentially:
the second pool is only tapped once the first is exhausted.

Appstrate will still try to recover automatically on first failure — if
the error above appears despite tuning, the platform reclaims orphan
`appstrate-exec-*` networks from crashed runs and retries once. The
remediation above is the durable fix.

## Manual Setup

If you prefer to set up manually (or can't use the one-liner):

1. **Create the environment file**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set production-safe secrets:

   ```bash
   # Generate secrets (run each command and paste the output into .env)
   openssl rand -hex 32      # BETTER_AUTH_SECRET
   openssl rand -hex 32      # RUN_TOKEN_SECRET
   openssl rand -base64 32   # CONNECTION_ENCRYPTION_KEY
   ```

2. **Start the stack**

   ```bash
   docker compose up -d
   ```

   This will:
   - Start PostgreSQL, Redis, and MinIO
   - Initialize the MinIO bucket
   - Run database migrations
   - Pre-pull the Pi agent and sidecar runtime images
   - Start the Appstrate platform on port 3000

3. **Access the dashboard**

   Open [http://localhost:3000](http://localhost:3000) in your browser. After signup, the onboarding flow guides you to create your first organization.

## Architecture

```
                      :3000
                        |
                   [Appstrate]
                    /   |    \
            [Postgres] [Redis] [MinIO]
              :5432     :6379   :9000

            + Docker socket (agent runs)
              -> Pi agent containers
              -> Sidecar proxy containers
```

- **Appstrate** -- the main platform (API + web UI)
- **PostgreSQL 16** -- primary database (users, agents, runs, connections)
- **Redis 7** -- scheduling (BullMQ), rate limiting, cancel signaling, OAuth PKCE state
- **MinIO** -- S3-compatible object storage (agent packages, run artifacts)

## Upgrading

```bash
# Pull the latest images and restart
docker compose pull
docker compose up -d
```

Migrations run automatically on startup via the `appstrate-migrate` service.

## Configuration

See `.env.example` for all available environment variables. Key settings:

| Variable                                  | Description                                              |
| ----------------------------------------- | -------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD`     | Database credentials                                     |
| `BETTER_AUTH_SECRET`                      | Session signing secret (32 bytes hex)                    |
| `CONNECTION_ENCRYPTION_KEY`               | Credential encryption key (32 bytes base64)              |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO admin credentials                                  |
| `APP_URL`                                 | Public URL (for OAuth callbacks, email links)            |
| `TRUSTED_ORIGINS`                         | CORS origins (comma-separated)                           |
| `SYSTEM_PROVIDER_KEYS`                    | Pre-configured LLM provider credentials (JSON array)     |
| `SIDECAR_POOL_SIZE`                       | Pre-warmed sidecar containers (default: 2, 0 to disable) |
| `LOG_LEVEL`                               | Logging verbosity: `debug`, `info`, `warn`, `error`      |

## Locking Down Signup (Closed Mode)

By default Appstrate runs in **open mode** — anyone with the URL can sign
up and create their own organization. For private production deployments,
switch to **closed mode** (invitation-only signup, single-org-per-tenant,
optional domain allowlist):

```env
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_PLATFORM_ADMIN_EMAILS=admin@your-domain.com
AUTH_ALLOWED_SIGNUP_DOMAINS=acme.com         # optional — restrict invitee domains
AUTH_BOOTSTRAP_OWNER_EMAIL=admin@your-domain.com
AUTH_BOOTSTRAP_ORG_NAME=Acme
```

Sign up once as the bootstrap email — the root organization is created
automatically. Invite teammates from the dashboard; invitations bypass the
signup lock.

Full guide, recipes, and pitfalls: [`AUTH_MODES.md`](./AUTH_MODES.md).

## LLM Provider Setup

Appstrate needs at least one LLM provider to run agents. Configure it via the `SYSTEM_PROVIDER_KEYS` environment variable:

```bash
SYSTEM_PROVIDER_KEYS='[{"id":"anthropic","label":"Anthropic","api":"anthropic-messages","baseUrl":"https://api.anthropic.com","apiKey":"sk-ant-...","models":[{"modelId":"claude-sonnet-4-6","label":"Claude Sonnet 4.6","isDefault":true}]}]'
```

## Data Persistence

Three named volumes store persistent data:

- `pgdata` -- PostgreSQL database files
- `redisdata` -- Redis AOF/RDB snapshots
- `miniodata` -- MinIO object storage

To reset all data: `appstrate uninstall --purge` (or, raw:
`docker compose down -v` from the install directory). Both destroy
the named volumes — the Appstrate CLI form additionally removes the
install dir itself, so use it only when you intend a full wipe.

## Production Considerations

- Place a reverse proxy (nginx, Caddy, Traefik) in front of Appstrate for TLS termination
- Set `APP_URL` to your public HTTPS URL
- Set `TRUSTED_ORIGINS` to your public domain
- Use strong, unique secrets for all `*_SECRET` and `*_PASSWORD` variables
- Consider backing up the `pgdata` volume regularly
- Set `SIDECAR_POOL_SIZE=0` if memory is constrained and cold-start latency is acceptable
