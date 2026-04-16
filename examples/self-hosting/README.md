# Self-Hosting

Deploy Appstrate with PostgreSQL, Redis, and MinIO using Docker Compose.

## One-Liner Install (Recommended)

```bash
curl -fsSL https://get.appstrate.dev | bash
```

The installer handles everything automatically:

- Checks prerequisites (Docker 20+, Compose V2, curl, openssl)
- Generates cryptographic secrets (auth, encryption, DB passwords)
- Detects the Docker socket GID for container access
- Downloads and starts the full stack
- Waits for the platform to become healthy
- Rolls back automatically to the previous version on upgrade failure

Open [http://localhost:3000](http://localhost:3000) and sign up.

Overrides: `APPSTRATE_VERSION=v1.2.3`, `APPSTRATE_DIR=~/.appstrate`, `APPSTRATE_PORT=8080`.

To upgrade, re-run the same command — existing secrets are preserved and new config keys are merged automatically.

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

`verify.sh` and `appstrate.pub` only appear on `get.appstrate.dev` once the signing keypair is provisioned (see **Maintainer: signing setup** below). Until then, use SLSA provenance or rely on TLS.

### Maintainer: signing setup

One-time bootstrap to enable minisign signatures on releases:

1. **Generate a keypair** (offline, on a trusted machine):

   ```bash
   minisign -G -p appstrate.pub -s appstrate.key
   ```

   Choose a strong passphrase. Back up `appstrate.key` in a password manager or hardware token — losing it forces a key rotation.

2. **Commit the public key** to the repo:

   ```bash
   cp appstrate.pub appstrate/scripts/appstrate.pub
   git add scripts/appstrate.pub && git commit -m "chore: add installer signing pubkey"
   ```

3. **Store the private key + passphrase** as GitHub Actions secrets on the `appstrate/appstrate` repo:
   - `MINISIGN_SECRET_KEY` — full contents of `appstrate.key`
   - `MINISIGN_PASSWORD` — the passphrase

4. **Re-run the publish workflow** on an existing tag (or cut a new one). `publish-installer.yml` will detect the secret, sign `install.sh`, and publish `install.sh.minisig` + `appstrate.pub` to the `get.appstrate.dev` branch.

**Rotation**: generate a new keypair, update `scripts/appstrate.pub` and the GitHub secrets in the same PR, announce the old key as retired in the release notes, and bump the installer with the new pubkey.

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
