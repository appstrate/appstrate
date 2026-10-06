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
