# deploy — the production deployment

The compose that runs `app.appstrate.com`. **No product code lives here**: `docker-compose.yml` pulls published images, and that is the whole directory.

It used to be a repository of its own, `appstrate/cloud`, holding the billing module and a `Dockerfile` that layered it onto the OSS image. That module is now `packages/module-ee` and ships inside `ghcr.io/appstrate/appstrate` itself, inert until `MODULES` names it — one image, one tag, nothing to build. With nothing left to build, a separate repository bought only a second place to look, so the compose moved here and `appstrate/cloud` is archived.

## Layout

|                      |                                                             |
| -------------------- | ----------------------------------------------------------- |
| `docker-compose.yml` | every service, every image pinned to `${APPSTRATE_VERSION}` |
| `.env.example`       | the variables the compose reads, for a raw `docker compose` |

## This is not the self-hosting example

`examples/self-hosting/docker-compose.yml` teaches a stock install. The two files overlap and are deliberately **not** merged:

|                 | `deploy/`                                  | `examples/self-hosting/`                                 |
| --------------- | ------------------------------------------ | -------------------------------------------------------- |
| project `name:` | `appstrate-cloud`                          | `appstrate`                                              |
| services        | `appstrate-postgres`, `appstrate-minio`, … | `postgres`, `minio`, …                                   |
| networks        | none (Coolify supplies one)                | `appstrate-data` (`internal: true`) + `appstrate-public` |

Coolify's `docker_compose_domains` maps **these** service names to `app.appstrate.com` and `storage.appstrate.com`, so renaming one deletes the routing; and an `internal: true` network on `appstrate` would cut its egress to the model providers. A change that belongs in both files is carried across by hand.

## Upgrading

1. Set `APPSTRATE_VERSION` to the release tag **without the `v`** (`1.0.0-beta.58`, not `v1.0.0-beta.58`).
2. Redeploy.

`appstrate-migrate` runs the platform's schema migrations before the application starts (`depends_on: service_completed_successfully`), and `@appstrate/module-ee` migrates its own `ee_*` tables at `init()`. A release that needs more than that says so in `CHANGELOG.md`, and the procedure lives in **`scripts/migration/README.md`** — read it before changing the version, not after.

**A release is not always an image swap.** Migrations that cannot be replayed, one-off data scripts, and environment variables that must land at a particular moment are all real. The runbook is the authority; this file is not a substitute for it.

## Production

Deployed by Coolify, resource `i52ng4cu0qbow9dabgt8b37i`. Four facts worth writing down, because each one is easy to break:

- **The volumes are keyed on the Coolify resource UUID**, not on this file's `name:` — `<uuid>_pgdata`, `<uuid>_redisdata`, `<uuid>_miniodata`. Coolify overrides the compose project name with the UUID, which is why repointing the resource at this repository moved no data. `name:` is inert there but **not** for a raw `docker compose` run, which keys its volumes on it: it stays `appstrate-cloud`, repository or no repository. The top-level `volumes:` keys are load-bearing the same way — `<uuid>_pgdata` is derived from the key `pgdata`, so renaming it there orphans a volume rather than renaming one.

- **Coolify injects every variable configured on the resource into every service**, whatever the `environment:` blocks in this file list. Measured 2026-09-18: `CONNECT_SESSION_SECRET` and `UPLOAD_SIGNING_SECRET` are hard-required by `packages/env/src/index.ts`, were absent from this compose for months, and production booted anyway. Those blocks are the contract for a **raw** `docker compose` run — which is who they are maintained for, and why they are kept complete even though production does not read them.

- **Coolify regenerates `.env` from the resource's own environment configuration on every deploy.** A value written into the file on the server is gone at the next one. Edit the variables in Coolify, never the file.

- **`watch_paths` is set to this directory.** Without it, a push anywhere in the monorepo would redeploy production — and a deploy is not free: it re-pulls every image and restarts the whole stack. If you change `docker_compose_location`, change `watch_paths` in the same edit.

## Rollback

Set `APPSTRATE_VERSION` back and redeploy — but only where the release was an image swap. Once a release has applied migrations, the older build no longer matches the schema and rolling the application back alone is unsupported. The rollback is then the pre-deployment dump. The runbook says which case a given release is.

To roll the _source_ back rather than the version, point `git_repository` at `appstrate/cloud` and redeploy. An archived repository is read-only, not gone: Coolify can still clone it, and the volumes never moved, so this is a configuration revert and not a restore. That is the reason the repository is archived rather than deleted.
