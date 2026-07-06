# Deploying a preview build on Coolify

Ship an unmerged PR to the staging/prod server to try it before merge. The
`preview` workflow (`.github/workflows/preview.yml`) builds the full 8-image
stack from the PR and publishes it to GHCR under a `pr-<number>` tag.

## 1. Publish the preview images

1. Add the **`preview`** label to the PR.
2. Wait for the **Preview Images** workflow to finish (~10–30 min cold, faster
   warm). Every subsequent push to a labeled PR republishes automatically.
3. The workflow posts (and keeps updated) a comment on the PR with the exact
   tag, e.g.:

   > 🚀 Preview images published — Tag: `pr-482`

   > Building an arbitrary branch/tag instead of a PR? Run the workflow
   > manually (`workflow_dispatch`) with a `ref`; the tag becomes
   > `preview-<ref-slug>`.

## 2. Point Coolify at the tag

Set the version variable on the deployment and redeploy:

```sh
APPSTRATE_VERSION=pr-482
```

All 8 images share the tag, so this single variable moves the whole stack
(`appstrate`, `appstrate-pi`, `appstrate-sidecar`, and the five
`appstrate-mcp-runner-*` images).

### Pre-pull on slow links (important)

Coolify's deploy task **times out at 10 minutes**. A cold pull of all 8 images
from GHCR can exceed that and leave the deploy half-applied. On a slow
connection, pull them on the host first, then redeploy:

```sh
# On the Coolify host, from the app's compose directory:
APPSTRATE_VERSION=pr-482 docker compose pull
```

With the images already local, the Coolify deploy only has to restart
containers and finishes well inside the timeout.

## 3. Roll back

Preview tags are additive — nothing is overwritten. To roll back, set
`APPSTRATE_VERSION` back to the version you were on (the previous `pr-<n>`, a
released `vX.Y.Z`, or `latest`) and redeploy:

```sh
APPSTRATE_VERSION=v1.4.0   # or the previous preview tag
```

## Notes

- **amd64 only.** Preview images are built for `linux/amd64` (the staging/prod
  server). They will not run on an arm64 host.
- **Not a release.** No CLI binaries, no GH Release, no `latest` retag — a
  preview tag is only for pointing a Coolify deployment at unmerged code.
- **Cleanup.** Preview tags accumulate on GHCR; prune old `pr-*` tags via the
  package's GHCR retention policy or manually once the PR is merged/closed.
