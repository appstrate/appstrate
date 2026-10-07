# Public documentation source

This directory is the source of the documentation published on the Appstrate website under `/docs`.
It is **not** rendered here: the website repository (`appstrate/website`) copies it into its own
`content/docs/` at build time with `scripts/sync-docs.ts`. This file is not copied.

## What lives where

| Page or section                                                                                                       | Source                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `get-started/`, `using-appstrate/`, `features/`, `integrations/`, `self-hosting/`, `resources/`                       | this directory                                                                |
| `api/` guides (`introduction`, `quickstart`, `authentication`, ...) and the order of the API groups (`api/meta.json`) | this directory                                                                |
| `/docs/self-hosting/environment-variables`                                                                            | [`../ENV.md`](../ENV.md), generated. Do not create a page here                |
| One page per API operation under `api/<tag>/`                                                                         | The OpenAPI spec (`apps/api/src/openapi`), generated. Do not create them here |

A fact has one home. Environment variables live in `ENV.md`, internals in `docs/architecture/`.
A page here summarises in a sentence and links to GitHub.

## Rules

- English prose. No em dash and no double hyphen as punctuation (flags inside code are fine).
- Every page has `title` and `description` frontmatter and is listed in its folder's `meta.json`.
- Internal links are site paths (`/docs/features/agents`), repository files are GitHub URLs.
- Never rename or remove a page without telling the website: its old URL needs a redirect.
- Escape `{`, `}` and bare `<` outside code fences (MDX).
- Verify a claim against the code before writing it. A command, a default, an endpoint or a name
  that cannot be checked does not belong in the docs.

## Preview

From a checkout of `appstrate/website`:

```sh
DOCS_SOURCE_DIR=/path/to/appstrate bun run dev
```

Re-run `bun run docs:sync` after editing a page. Without `DOCS_SOURCE_DIR` the script clones
`main` of this repository.

## Publishing

Nothing here is deployed by this repository. The website (`appstrate/website`) builds the docs when it
is deployed, so a docs change reaches the public site only after a website rebuild.

- **Automatic rebuild.** `.github/workflows/docs-site.yml` calls Coolify with `force=true` when
  `docs/site/**` or `docs/ENV.md` changes on `main`. The `force` is required: the website image build is
  cached on the website repository's own files, so a plain redeploy would reuse the previous docs. The
  workflow does nothing until the repository has the secret `COOLIFY_API_TOKEN` (ability `deploy`) and the
  variables `COOLIFY_URL` and `WEBSITE_COOLIFY_UUID` (the website application in Coolify). Check
  **Settings > Secrets and variables > Actions** if the site does not follow a merge.
- **Manual rebuild.** Redeploy the website application in Coolify with the force option, or run the
  workflow with `workflow_dispatch`.
- **Renaming or removing a page** also needs a line in `docs-redirects.mjs` in the website repository,
  otherwise the old public URL answers 404.
- **API reference.** Its pages come from the OpenAPI spec of the instance that runs `main`
  (`https://app.appstrate.com/api/openapi.json`), so a new endpoint appears on the site once that instance
  is deployed, not at merge. A tag used by an operation must be declared in `apps/api/src/openapi/info.ts`.
- **Preview before merging.** From a checkout of `appstrate/website`:
  `DOCS_SOURCE_DIR=/path/to/appstrate bun run build` builds the site with your local pages and fails on a
  broken MDX page. Crawl the result for dead `/docs/...` links before you merge a large change.

## Keeping the docs true

A page is only worth its claims. Before merging a change to `docs/site/`, trace each command, default,
endpoint, flag and UI label you touched to the code. A claim that cannot be traced is deleted, not softened.
Pages describing a release should name no version the code does not show: use the release the change
shipped in, from `CHANGELOG.md`.
