# Staging — `main`, deployed continuously

Staging runs the head of `main`. Nobody deploys it: every push to `main` does.

## What a merge triggers

`.github/workflows/preview.yml`, on a push to `main`:

1. builds the 8-image stack (amd64) and publishes it under `main` and `main-<sha>`;
2. once every image is pushed, the `deploy-staging` job sets `APPSTRATE_VERSION=main-<sha>` on the
   staging Coolify resource and starts a deployment;
3. waits for Coolify to report it `finished`, then reads `/health` until the platform answers with
   that commit. A deployment that fails, or a platform that never reports the commit, fails the job.

A merge landing while a run is in flight cancels it: staging converges on the newest commit, it does
not replay every one.

Staging is pointed at `main-<sha>`, never at `main`. A cancelled run leaves `main` moved on some of
the 8 images and not the others, and the platform, `PI_IMAGE` and `SIDECAR_IMAGE` are one version
contract (`AGENTS.md`).

A deployment restarts the whole stack, so a run in flight on staging is interrupted by the next
merge.

## The same compose as production

Staging deploys `deploy/docker-compose.yml`, the file production runs. There is no staging compose
and nothing staging-specific in the tree: what differs is the Coolify resource (its domains, its
environment, its volumes) and the tag.

## Schema and data

`appstrate-migrate` applies the pending drizzle migrations on every deployment, before the
application starts. That is the whole of what is automatic.

The scripts in `scripts/migration/` are **not** run on staging, by the workflow or by anything else:
they are run once, deliberately, by an operator, against a deployment whose rows need them
(`docs/NO_TRANSITIONAL_CODE.md`). Staging's rows are not such rows. **Its data is disposable**: when
a merge leaves existing rows in a shape the new build refuses, staging is reset, not repaired. An
empty database needs no script.

What this costs: staging never shows a migration passing on real data. That evidence is the
rehearsal on a production dump before each release (`scripts/migration/README.md`), and staging does
not replace it.

### Resetting staging

1. Stop the resource in Coolify.
2. On the host, remove its volumes: `docker volume rm <uuid>_pgdata <uuid>_redisdata <uuid>_miniodata`
   (the UUID is the resource's — `deploy/README.md`, "Production").
3. Re-run the latest `Preview Images` run on `main`, or redeploy from Coolify.

## Rollback

Revert the commit on `main`. Re-running an older workflow run is not a rollback: it shares the
concurrency group of the newest one and cancels it.

## Setup

### The Coolify resource

One `dockercompose` application resource:

|                           |                                                                        |
| ------------------------- | ---------------------------------------------------------------------- |
| repository, branch        | `appstrate/appstrate`, `main`                                          |
| `docker_compose_location` | `/deploy/docker-compose.yml`                                           |
| automatic deployment      | **off**                                                                |
| domains                   | one for the `appstrate` service, one for `appstrate-minio`             |
| environment               | `deploy/.env.example`, with secrets and third-party keys of its own    |
| `APPSTRATE_VERSION`       | created once with any published tag; the workflow owns it from then on |

Automatic deployment is off because the workflow is the only trigger. A deployment started by the
push itself would run before the images of that commit exist, and restart the stack on the previous
tag for nothing.

Nothing of production's goes on this resource: no secret, no Stripe live key, no OAuth client, no
data.

### The `staging` GitHub environment

|          |                    |                                                                |
| -------- | ------------------ | -------------------------------------------------------------- |
| variable | `COOLIFY_APP_UUID` | UUID of the resource                                           |
| secret   | `COOLIFY_URL`      | origin of the Coolify instance, no trailing slash              |
| secret   | `STAGING_URL`      | public origin of staging, no trailing slash                    |
| secret   | `COOLIFY_TOKEN`    | Coolify API token with the `read`, `write`, `deploy` abilities |

The two origins are secrets, not variables, so that Actions masks them in this repository's public
logs.

Restrict the environment's deployment branches to `main`. That restriction, not the job's `if:`, is
what keeps the token out of reach of a pull request that edits the workflow.

The job fails on a missing value. It has no "not configured, skipping" branch.

### On a Docker host shared with another Appstrate deployment

Two facts are per Docker daemon, not per deployment:

- **Image pin holders are named `appstrate-imagepin-<slot>`.** Two deployments on one daemon replace
  each other's pin at every warm sweep. Set `RUNTIME_IMAGE_WARM_INTERVAL_SECONDS=0` on staging: it
  re-pulls its images at every deployment anyway.
- **`PLATFORM_SINK_PORT` is a host port.** Give each deployment its own.
