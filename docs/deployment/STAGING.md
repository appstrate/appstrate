# Staging — `main`, deployed continuously

Staging runs the head of `main`. Nobody deploys it: every push to `main` does.

## What a merge triggers

`.github/workflows/preview.yml`, on a push to `main`:

1. builds the 8-image stack (amd64) and pushes each image under `main-<sha>`;
2. once every image is pushed, moves the `main` tag onto all 8 (`promote`);
3. calls the staging **deploy hook** (`deploy-staging`);
4. reads `/health` until the platform answers with that commit. A platform that never reports it
   within 20 minutes fails the job.

A merge landing while a run is in flight cancels it: staging converges on the newest commit, it does
not replay every one.

`main` only ever moves as a whole, after the build. Staging tracks that tag, and the platform,
`PI_IMAGE` and `SIDECAR_IMAGE` are one version contract (`AGENTS.md`): a tag moved image by image
would be a trio that disagrees for as long as the build runs, and for good when it fails.

### The deploy hook

The workflow knows nothing about what hosts staging. It sends one request:

```
POST <DEPLOY_HOOK_URL>
Authorization: Bearer <DEPLOY_HOOK_TOKEN>
```

and expects a 2xx meaning "a deployment was accepted". What the hook must do is redeploy the stack
with a fresh pull, so that `main` resolves to the images just promoted. Whether that deployment
succeeded is not read off the hook's answer: step 4 is the verdict.

A deployment restarts the whole stack, so a run in flight on staging is interrupted by the next
merge.

## The same compose as production

Staging deploys `deploy/docker-compose.yml`, the file production runs. There is no staging compose
and nothing staging-specific in the tree: what differs is where it runs (its domains, its
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

1. Stop the stack.
2. Remove its three volumes (`pgdata`, `redisdata`, `miniodata`, under the project name the host
   gives them — `deploy/README.md`, "Production", for Coolify).
3. Call the deploy hook, or re-run the latest `Preview Images` run on `main`.

## Rollback

Revert the commit on `main`. Re-running an older workflow run is not a rollback: it shares the
concurrency group of the newest one and cancels it, and it would move `main` back for every consumer
of the tag.

## Setup

### The staging stack

Whatever hosts it, staging is `deploy/docker-compose.yml` run with:

|                     |                                                                     |
| ------------------- | ------------------------------------------------------------------- |
| `APPSTRATE_VERSION` | `main`                                                              |
| environment         | `deploy/.env.example`, with secrets and third-party keys of its own |
| deployment trigger  | the deploy hook, and nothing else                                   |

A deployment started by the push itself (a git webhook, a branch watcher) would run before the
images of that commit exist, and restart the stack on the previous build for nothing. Turn it off.

Nothing of production's goes on this stack: no secret, no Stripe key, no OAuth client, no data. Its
Stripe webhook endpoint is created at the API version `STRIPE_API_VERSION` pins
(`packages/module-ee/src/stripe/client.ts`), since a webhook payload is rendered at the endpoint's
version, not the client's.

Under Coolify, which is what `deploy/README.md` documents, the hook is the application's deploy
endpoint, `<coolify>/api/v1/deploy?uuid=<resource uuid>`, called with an API token holding the
`deploy` ability alone, and the resource's auto-deploy is set to manual.

### The `staging` GitHub environment

|        |                     |                                             |
| ------ | ------------------- | ------------------------------------------- |
| secret | `DEPLOY_HOOK_URL`   | the hook, query string included             |
| secret | `DEPLOY_HOOK_TOKEN` | its bearer token                            |
| secret | `STAGING_URL`       | public origin of staging, no trailing slash |

The two URLs are secrets, not variables, so that Actions masks them in this repository's public
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
