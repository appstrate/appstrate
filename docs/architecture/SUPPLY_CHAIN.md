# Supply-Chain Posture — Pi SDK (single-vendor dependency)

Status: active. Addresses [#616](https://github.com/appstrate/appstrate/issues/616) item 2
("single-vendor SDK supply-chain risk").

The agent execution path depends on a single-maintainer SDK published by one
author:

- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

(plus their transitive siblings `@mariozechner/pi-agent-core`,
`@mariozechner/pi-tui`).

This document records why that risk is bounded today, the controls in place,
and the concrete plan for substituting a forked/vendored SDK in an emergency.
It is intended to double as the rationale for a future ADR.

## 1. Isolation wall — the coupling is shallow

The Pi SDK is **not** a cross-cutting dependency. It is confined to the agent
runner and its container image. The platform core, the cloud billing module,
and the published `@appstrate/core` library import it **zero** times.

```
apps/api   (Hono backend)      → 0 pi-* imports
cloud      (billing module)    → 0 pi-* imports
packages/core (@appstrate/core)→ 0 pi-* imports
```

All SDK usage lives behind a hard process/architecture boundary: the agent runs
inside a sandboxed container, and credentials are mediated by the sidecar (see
`SIDECAR.md`). The SDK never sees platform credentials and never executes inside
the API process.

The entire import surface, after this hardening, is **three barrel files**:

| Package                | Barrel                             | Symbols consumed                                                                                                                                                                                            |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@appstrate/runner-pi` | `packages/runner-pi/src/pi-sdk.ts` | `AuthStorage`, `createAgentSession`, `DefaultResourceLoader`, `ModelRegistry`, `SessionManager`, `SettingsManager`, `Type` (values); `ExtensionAPI`, `ExtensionFactory`, `Api`, `KnownApi`, `Model` (types) |
| `runtime-pi` (image)   | `runtime-pi/pi-sdk.ts`             | `Type` (value); `ExtensionAPI`, `ExtensionFactory`, `Api`, `Model` (types)                                                                                                                                  |
| `@appstrate/cli`       | `apps/cli/src/lib/pi-sdk.ts`       | `Api`, `Model` (types)                                                                                                                                                                                      |

Every other module imports these symbols from its package-local barrel, never
from the SDK directly.

> `examples/custom-skill/skill.ts` intentionally imports
> `@mariozechner/pi-coding-agent` directly — it is user-facing documentation that
> demonstrates the real SDK extension API a skill author writes against, not
> platform code. It is outside the guard scope on purpose.

## 2. Controls

### Exact version pin (no caret)

Both packages are pinned to an **exact** version (`0.70.6`, no `^`) in every
`package.json` that declares them — `package.json` (root), `apps/api`,
`apps/cli`, `runtime-pi`, `packages/runner-pi` (deps + peer + dev),
`packages/afps-runtime` (peer + dev). Combined with the committed `bun.lock`
(integrity hashes), this blocks **silent minor/patch bumps** of a single-author
dependency — every version change is an explicit, reviewable diff.

Peer-dependency ranges on the published `@appstrate/runner-pi` /
`@appstrate/afps-runtime` are pinned exact for the same reason: external embedders
get the same controlled version, and the fork-contingency below remains a
one-line override for them too.

### Single swap point (barrel) + ESLint guard

Because the SDK is imported only through the three `pi-sdk.ts` barrels, swapping
the implementation is a change to those files alone — no agent logic moves.

A `no-restricted-imports` rule in `eslint.config.mjs` forbids any direct
`@mariozechner/pi-*` import (the whole vendor family — including subpaths) outside
the barrels (the barrels are exempted via `ignores`). The guard covers every
declared SDK consumer tree: `packages/runner-pi/src`, `runtime-pi`, `apps/cli/src`,
`apps/api/src`, and `packages/afps-runtime/src`. `afps-runtime` is SDK-agnostic and
imports zero pi-\* symbols today, so it has no barrel — the guard simply keeps it
that way (a future direct import there fails `bun run check`). This keeps the
property true going forward — a new file that imports the SDK directly fails
`bun run check`.

`packages/core/src` is guarded the same way through core's own
`no-restricted-imports` block (it already bans cross-package workspace imports):
core imports the Pi SDK zero times and has no barrel, so the ban there is absolute.
It lives in core's block rather than the shared guard block because flat-config
last-match-wins would otherwise clobber core's workspace-independence rule.

A barrel-completeness test (`test/supply-chain-barrels.test.ts`) asserts each
barrel actually re-exports the value symbols its consumers import — a missing
re-export is a runtime crash the lint guard cannot catch. Type-only re-exports are
covered by `tsc` on the barrels' real consumers.

### Renovate / Dependabot

`renovate.json` carries a dedicated rule for the two packages: grouped into one
PR, labelled `supply-chain` / `pi-sdk`, `rangeStrategy: pin`, **no auto-merge**,
and gated behind `dependencyDashboardApproval`. Updates to this dependency are a
deliberate human decision, not an automated background bump.

## 3. Swap-cost estimate

| Scenario                                   | Cost                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Pin a new upstream version                 | 1 line per declaring `package.json` + `bun install` (lockfile diff reviewed)            |
| Substitute a drop-in fork (same API)       | 1 `package.json` `overrides` entry (see below) — **0 source edits**                     |
| Substitute a fork with API drift           | edit the 3 barrel files to adapt re-exports; agent logic untouched                      |
| Replace the SDK entirely with a new runner | re-implement behind the 3 barrels + the `Runner` interface in `@appstrate/afps-runtime` |

The realistic emergency case (compromised/yanked package, maintainer
abandonment) is the **drop-in fork**: one `overrides` line, no code change.

## 4. Fork-contingency plan (emergency substitution)

> Out of scope for this change: we do **not** vendor `node_modules` or stand up a
> registry mirror here. This section documents the concrete recipe so it can be
> executed under pressure.

If the upstream package must be replaced (compromise, yank, abandonment), point
the dependency tree at a controlled artifact using a Bun/npm **`overrides`** block
in the **root** `package.json`. Overrides apply to every workspace package
transitively, so this is a single edit:

```jsonc
// package.json (root)
{
  "overrides": {
    "zod": "4.4.3",
    // --- emergency Pi SDK substitution (pick ONE form per package) ---

    // a) npm alias to a published fork under our own scope:
    "@mariozechner/pi-ai": "npm:@appstrate/pi-ai-fork@0.70.6",
    "@mariozechner/pi-coding-agent": "npm:@appstrate/pi-coding-agent-fork@0.70.6",

    // b) pinned git fork (tag or commit SHA):
    // "@mariozechner/pi-ai": "github:appstrate/pi-ai-fork#v0.70.6",

    // c) vendored tarball committed to the repo (fully offline):
    // "@mariozechner/pi-ai": "file:./vendor/mariozechner-pi-ai-0.70.6.tgz"
  },
}
```

Then:

```sh
bun install            # re-resolves the tree against the override
bun run check          # tsc + eslint guard + prettier + verify:openapi
bun test               # runner-pi / runtime-pi / cli suites
```

The fork must keep the symbols listed in the barrel table above. If the fork's
API drifts, adapt the three `pi-sdk.ts` barrels (re-map names, wrap shapes) —
that is the only place the rest of the codebase touches the SDK.

For a fully air-gapped posture (vendored tarball or registry mirror), pair option
(c) with a committed `vendor/` artifact and verify its SHA against the original
before committing. That work is deliberately deferred — this document is the
playbook for when it becomes necessary.
