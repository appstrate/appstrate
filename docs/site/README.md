# Public documentation source

This directory is the source of the public documentation at <https://docs.appstrate.com>. The site
itself is [`../web/`](../web/), a static Next.js export that copies these pages into its own `content/`
at build time (`docs/web/scripts/sync-content.ts`). This file is not copied.

## What lives where

| Page or section                                                                                                       | Source                                                                |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `get-started/`, `using-appstrate/`, `features/`, `integrations/`, `self-hosting/`, `resources/`                       | this directory                                                        |
| `api/` guides (`introduction`, `quickstart`, `authentication`, ...) and the order of the API groups (`api/meta.json`) | this directory                                                        |
| `/self-hosting/environment-variables`                                                                                 | [`../ENV.md`](../ENV.md), generated. Do not create a page here        |
| One page per API operation under `api/<tag>/`                                                                         | The OpenAPI spec of this checkout, generated. Do not create them here |

A fact has one home. Environment variables live in `ENV.md`, internals in `docs/architecture/`.
A page here summarises in a sentence and links to GitHub.

## Rules

- English prose. No em dash and no double hyphen as punctuation (flags inside code are fine).
- Every page has `title` and `description` frontmatter and is listed in its folder's `meta.json`.
- Internal links are site paths from the root (`/features/agents`, never `/docs/features/agents`),
  repository files are GitHub URLs. The build fails on a `/docs/...` link, a dead link or a missing anchor.
- Never rename or remove a page without a redirect for its old URL in `docs/web/public/_redirects`.
- Escape `{`, `}` and bare `<` outside code fences (MDX).
- Verify a claim against the code before writing it. A command, a default, an endpoint or a name
  that cannot be checked does not belong in the docs.

## Preview

```sh
cd docs/web
bun install            # once; the repository root needs its own `bun install` too
bun run dev            # http://localhost:3480, rebuilds content/ first
bun run build          # the static site in out/, then the link check
bun run preview        # serves out/ with the /errors function, as Cloudflare does
```

`bun run content` regenerates `content/` and `openapi.json` after editing a page or the spec.

## Publishing

`.github/workflows/docs-site.yml` builds `docs/web` and deploys `out/` with `wrangler pages deploy` to the
Cloudflare Pages project `appstrate-docs`, which serves `docs.appstrate.com`.

- **When.** Every pull request touching `docs/**`, the OpenAPI sources or the modules builds the site and
  fails on a broken MDX page or a dead internal link or anchor; with the secrets present it also deploys a
  preview at `<branch>.appstrate-docs.pages.dev`. A merge to `main` deploys production. Forks only build.
- **Secrets.** `CLOUDFLARE_API_TOKEN` (Account > Cloudflare Pages > Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  Without them the deploy step is skipped.
- **API reference.** Generated at build time from the OpenAPI document of the same commit
  (`scripts/export-openapi.ts`, every module in the tree), so it changes in the pull request that changes
  the endpoint. A tag used by an operation should be declared in `apps/api/src/openapi/info.ts`.
- **Redirects.** `docs/web/public/_redirects` (Cloudflare syntax, first match wins). It maps the pages
  removed before the move and sends any other `/docs/<path>` to `/<path>`, so the old paths keep working
  once `appstrate.com/docs/*` forwards to this host.
- **Error URIs.** The API's `type: https://docs.appstrate.dev/errors/<code>` and the runtime's
  `/errors/afps/<code>` are answered by `docs/web/functions/errors/[[path]].ts`, which redirects to the
  matching `code-<code>` or `code-afps-<code>` anchor of `/api/errors`.

## Keeping the docs true

A page is only worth its claims. Before merging a change to `docs/site/`, trace each command, default,
endpoint, flag and UI label you touched to the code. A claim that cannot be traced is deleted, not softened.
Pages describing a release should name no version the code does not show: use the release the change
shipped in, from `CHANGELOG.md`.
