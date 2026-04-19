# Self-Hosting

Deploy Appstrate via the official `appstrate` CLI, or manually with
Docker Compose. This directory holds the production `docker-compose.yml`
(the Tier 3 full stack: PostgreSQL + Redis + MinIO) plus progressive
`docker-compose.tier{1,2,3}.yml` templates used by `appstrate install`.

## One-Liner Install (Recommended)

```bash
curl -fsSL https://get.appstrate.dev | bash
```

This downloads the `appstrate` CLI binary for your OS/arch and hands
control to `appstrate install`. Just press Enter at the tier prompt to
land on the recommended Tier 3 production stack:

- **Tier 3** — Postgres + Redis + MinIO (full production, **default — what this README covers**)
- **Tier 2** — Postgres + Redis (no object storage)
- **Tier 1** — Postgres only (dev / testing)
- **Tier 0** — Bun + PGlite + filesystem (no Docker, hobby / evaluation)

If Docker is not detected on your machine the CLI automatically falls
back to Tier 0 as the highlighted default.

The CLI generates cryptographic secrets, writes `.env` +
`docker-compose.yml`, runs `docker compose up -d`, waits for the
healthcheck, and opens http://localhost:3000 in your browser.

Overrides: `APPSTRATE_VERSION=v1.2.3` (env var pins a specific release
binary). Non-interactive: `curl ... | bash -s -- --tier 3 --dir ~/appstrate`.

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

To reset all data: `docker compose down -v` (destroys volumes).

## Production Considerations

- Place a reverse proxy (nginx, Caddy, Traefik) in front of Appstrate for TLS termination
- Set `APP_URL` to your public HTTPS URL
- Set `TRUSTED_ORIGINS` to your public domain
- Use strong, unique secrets for all `*_SECRET` and `*_PASSWORD` variables
- Consider backing up the `pgdata` volume regularly
- Set `SIDECAR_POOL_SIZE=0` if memory is constrained and cold-start latency is acceptable
