# deploy — the production deployment

The compose that runs `app.appstrate.com`. **No product code lives here**: `docker-compose.yml` pulls published images, and that is the whole directory.

The billing module is `packages/module-ee`, and it ships inside `ghcr.io/appstrate/appstrate` itself, inert until `MODULES` names it. One image, one tag, nothing to build — which is why the deployment is one file in the monorepo rather than a repository of its own.

## Layout

|                      |                                                             |
| -------------------- | ----------------------------------------------------------- |
| `docker-compose.yml` | every service, every image pinned to `${APPSTRATE_VERSION}` |
| `.env.example`       | the variables the compose reads, for a raw `docker compose` |

## This is not the self-hosting example

`examples/self-hosting/docker-compose.yml` teaches a stock install. The two files overlap and are deliberately **not** merged:

|                 | `deploy/`                                  | `examples/self-hosting/`                                 |
| --------------- | ------------------------------------------ | -------------------------------------------------------- |
| project `name:` | `appstrate-prod`                           | `appstrate`                                              |
| services        | `appstrate-postgres`, `appstrate-minio`, … | `postgres`, `minio`, …                                   |
| networks        | none (Coolify supplies one)                | `appstrate-data` (`internal: true`) + `appstrate-public` |

Coolify's `docker_compose_domains` maps **these** service names to `app.appstrate.com` and `storage.appstrate.com`, so renaming one deletes the routing; and an `internal: true` network on `appstrate` would cut its egress to the model providers. A change that belongs in both files is carried across by hand.

## Upgrading

1. Set `APPSTRATE_VERSION` to the release tag **without the `v`** (`1.0.0-beta.62`, not `v1.0.0-beta.62`).
2. Redeploy.

`appstrate-migrate` runs the platform's schema migrations before the application starts (`depends_on: service_completed_successfully`), and `@appstrate/module-ee` migrates its own `ee_*` tables at `init()`. A release that needs more than that says so in `CHANGELOG.md`, and the procedure lives in **`scripts/migration/README.md`** — read it before changing the version, not after.

**A release is not always an image swap.** Migrations that cannot be replayed, one-off data scripts, and environment variables that must land at a particular moment are all real. The runbook is the authority; this file is not a substitute for it.

## Production

Deployed by Coolify as a single `dockercompose` application resource. Its UUID is not written here on purpose: the UUID names the volumes, and a stale one in a document is worse than none — read it off the resource.

Facts worth writing down, because each one is easy to break:

- **The volumes are keyed on the Coolify resource UUID**, not on this file's `name:` — `<uuid>_pgdata`, `<uuid>_redisdata`, `<uuid>_miniodata`. Coolify overrides the compose project name with the UUID (it passes `--project-name <uuid>`), so the UUID is what the data is attached to. Two consequences, in opposite directions: repointing an EXISTING resource at another repository moves no data, and standing up a NEW resource gives you empty volumes however faithfully you copy this file. A new resource is a data migration, not a configuration change.

- **`name:` is inert under Coolify and load-bearing off it.** A raw `docker compose` run keys its volumes on it. It reads `appstrate-prod`, not `appstrate`, because `examples/self-hosting/docker-compose.yml` claims that one and two compose files sharing a project name share its volumes. The top-level `volumes:` keys are load-bearing the same way, and under Coolify more so — `<uuid>_pgdata` derives from the key `pgdata`, so renaming it there orphans a volume rather than renaming one.

- **Coolify injects every variable configured on the resource into every service**, whatever the `environment:` blocks in `docker-compose.yml` list. So those blocks are not production's contract — `.env.example` is, and the blocks are the contract for a **raw** `docker compose` run. That is who they are maintained for, and it is why a variable missing from them can go unnoticed here for months.

- **A bare name in an `environment:` block is materialised as the empty string.** Coolify rewrites `- FOO` into `FOO: ''` in the compose it generates, so "unset, let the schema default apply" is a state that file cannot express. `verify:compose-defaults` (class 5) refuses one, and `env_file` is what delivers the operator's variables instead.

- **`MODULES` is required, not defaulted.** `docker-compose.yml` reads it as `${MODULES:?}`: a raw `docker compose` refuses to start without it, and Coolify documents that form as flagging the variable and blocking the deploy until a value is entered. There is no fallback list, and the code default names no billing module. Set it on the resource with `@appstrate/module-ee` included; its Stripe keys are then required (`.env.example` lists them).

- **Check what Coolify actually ran, not this file.** Coolify rewrites the compose before running it, so after a deploy read `/data/coolify/applications/<uuid>/docker-compose.yaml` on the server: `MODULES` must appear there with the resource's value, `@appstrate/module-ee` included.

- **Coolify regenerates `.env` from the resource's own environment configuration on every deploy.** A value written into the file on the server is gone at the next one. Edit the variables in Coolify, never the file.

- **`<uuid>_miniodata` must be owned by `65532:65532`.** `appstrate-minio` runs as that uid, and on root-owned files — a volume written by an image that ran as root, or restored as root — it crash-loops with `FATAL Unable to initialize backend: Unable to write to the backend` and the deploy never turns healthy. The compose has no override for it; re-own the volume. On the server: stop the application in Coolify, snapshot the volume, re-own it, deploy.

  ```sh
  docker volume create <uuid>_miniodata_backup
  docker run --rm -v <uuid>_miniodata:/from:ro -v <uuid>_miniodata_backup:/to \
    --user 0 --entrypoint cp cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1 -a /from/. /to/
  docker run --rm -v <uuid>_miniodata:/data --user 0 --entrypoint chown \
    cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1 -R 65532:65532 /data
  ```

- **`watch_paths` is set to this directory.** Without it, a push anywhere in the monorepo would redeploy production — and a deploy is not free: it re-pulls every image and restarts the whole stack. If you change `docker_compose_location`, change `watch_paths` in the same edit.

## Rollback

Set `APPSTRATE_VERSION` back and redeploy — but only where the release was an image swap. Once a release has applied migrations, the older build no longer matches the schema and rolling the application back alone is unsupported. The rollback is then the pre-deployment dump. The runbook says which case a given release is.

To roll back further than the version — to the deployment this one replaced — there is no configuration revert available: that deployment was a different Coolify resource with volumes of its own. The rollback is its volumes if they still exist, and otherwise the pre-migration dump. Keep both until a full release has gone out on this resource without incident.
