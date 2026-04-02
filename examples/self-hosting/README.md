# Self-Hosting Example

Minimal Docker Compose setup for self-hosting Appstrate with PostgreSQL, Redis, and MinIO.

## Prerequisites

- Docker Engine 24+ with Compose V2
- At least 4 GB of available RAM
- Docker socket accessible at `/var/run/docker.sock` (required for agent runs)

## Quick Start

1. **Create the environment file**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set production-safe secrets:

   ```bash
   # Generate secrets (run each command and paste the output into .env)
   openssl rand -hex 32      # BETTER_AUTH_SECRET
   openssl rand -hex 32      # EXECUTION_TOKEN_SECRET
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

   Open [http://localhost:3000](http://localhost:3000) in your browser. The first signup creates an organization automatically.

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
