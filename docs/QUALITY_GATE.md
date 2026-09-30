# Quality gate — the `verify:dead-code` (knip) forensics

`verify:dead-code` runs `knip-bun` over every workspace as one of the task names of `bun run check`
(turbo reports it as `//#verify:dead-code`). It fails on an exported symbol with no reader, a file
nothing reaches, or a declared dependency nothing imports.

Extracted from the root `AGENTS.md` § "Quality Gate — and the signals it lies with", which keeps the
short version. This file holds the full record: what knip does and does not derive, which hypotheses
were measured and refuted, and the only two shapes of `ignore*` that qualify. Read it before touching
`knip.config.ts`.

## What is out of scope — the published packages

Public exports of the **published** packages are out of scope by design — their readers live out of
tree — and exactly two scoped packages here are published on an ongoing basis: `@appstrate/core` and
`@appstrate/afps-shared`, the only two SCOPED packages with a publish
workflow (`.github/workflows/publish-core.yml`, `publish-afps-shared.yml`) — `apps/cli` publishes
too, but unscoped as `appstrate`, through `publish-cli.yml`. `@appstrate/afps-runtime` carries
`publishConfig` but is **not** published (no workflow, no tag, a `0.0.0` npm placeholder) and stays
private by decision; `@appstrate/runner-pi` and the `@appstrate/module-*` packages are absent from
npm entirely — `@appstrate/module-ee` is additionally `"private": true` and source-available, never
published anywhere; `@appstrate/ui` is the inverse case — `"private": true` here, yet `ui@1.0.0` and
`ui@1.0.1` tags exist and 1.0.1 sits on npm, both left over from before that flag. There is no
`publish-ui.yml`, nothing republishes it, and it is treated as private. So a release tag alone
proves nothing — the live signal is the workflow, and the ground truth is `npm view <pkg> versions`,
never the manifest's `publishConfig`.

## `verify:dead-code` (knip) — what it does and does not derive

Fixed 2026-08-23. This section is kept because the failure mode is easy to
re-introduce with one careless edit to `knip.config.ts`.

Until then, `bun run check` failed locally on `//#verify:dead-code` with ~161
"unused exports", ~284 "unused exported types" and 6 "unused files" — on an
untouched `main` as well as on any branch. None of it was real, and because the
`pre-push` hook then ran `bun run check`, it blocked every local push.

The cause was read out of knip 5.88.1's `dist/` — the version pinned when this
was diagnosed. Each claim below was re-verified against **6.32.2**'s
`dist/`; `package.json` declares the range `^6.34.0` today — read the version there, not here:

- `ConfigurationChief.js` is the **only** place entry defaults are produced, and
  they are filename patterns: `{index,cli,main}.{exts}` at the package root and
  under `src/`. Still true at 6.32.2 (`defaultBaseFilenamePattern`,
  `getDefaultWorkspaceConfig`, lines 17–29 — the line number moved from :27).
- Declaring `entry` for a workspace **replaces** those filename defaults. Still
  true at 6.32.2 — `getDefaultWorkspaceConfig` supplies them only when the
  workspace config does not.
- **No longer true at 6.32.2**: 5.88.1 read nothing from the package manifest,
  so knip could not derive an entry from `exports` / `main` / `module`. 6.x does
  — `getEntrySpecifiersFromManifest()` (`util/package-json.js`) walks `main`,
  `module`, `browser`, `bin`, `types`/`typings` and the full `exports` map, and
  `graph/build.js` adds each resolved file as a production entry. Do not act on
  this by deleting `manifestEntries()` calls without measuring: the config's
  explicit list is also what documents intent, and the gate is green as written.

So under 5.88.1 knip never derived an entry from a package manifest, and a
workspace that declared `entry` lost even the filename defaults. Every workspace
here that declared one had silently lost its real entry points, and each loss
cascaded: `packages/afps-runtime/bin/afps.ts` unreachable makes its whole
`src/**` look dead, which was most of the 161.

**The rule when you touch `knip.config.ts`:** a workspace that declares `entry`
must carry every `exports` target, every `bin` target, and `main`/`module` if
present. Those files are reached by npm consumers and by the `MODULES` loader
resolving a specifier — neither of which knip can see. This half is no longer
written by hand: `manifestEntries(workspace)` reads the `package.json` and
derives it, so a manifest edit cannot silently desynchronise from the config.
Call it, do not transcribe its output, and do not collapse it into a broad glob
such as `src/*.ts!` — that is wider than the real export map and would hide a
genuinely dead root-level file. The one workspace it cannot serve is `apps/cli`,
whose `bin` points at a `dist/` build artifact absent from a clean checkout;
its entries are hand-written and say so at the call site. What stays
hand-written otherwise is the other half: the entries no manifest implies
(Docker CMDs, glob-discovered fixtures, operator scripts), each still owing the
"what reaches it" justification.

**Never un-export a symbol to make this gate quiet.** If a finding survives a
correct entry list, it is either real dead code or a symbol exported with no
reader at all — fix it at the source, or report it.

**An `ignore*` is not forbidden, but it is not a way out either.** Two shapes
qualify, and nothing else. The first is a false positive knip _structurally
cannot see_: a dynamic import, a binary invoked through `npx` or the shell, an
optional peer behind a runtime feature check, a reader inside the declaring
file itself, an npm contract, a wire format. The second is rarer and admits the
finding is TRUE — the export really has no reader today — but the code is
vendored in whole from an upstream generator, so pruning it buys nothing and
fights the next vendor diff; `packages/ui`'s shadcn/ui families are the only
instance, and even there only the `exports` issue is suppressed, never a
component file nothing imports. Either way the reason travels with the entry,
written at its call site in `knip.config.ts` — that file's rule 2 states the
first shape; the second is argued at the `ignoreIssues` entry itself. The live
carve-outs are `ignoreExportsUsedInFile`, `ignoreIssues`, `ignoreBinaries` and
three `ignoreDependencies` blocks; read their prose before adding a fourth of those.
They are deliberately NOT re-listed here — a second copy of that list would
drift from the config, and the config is where the justification has to live
anyway. What is forbidden is the other use: silencing a finding you have not
explained.

An earlier version of this record blamed `git worktree`, on the strength of one
clone that came back clean. That was wrong. Measured and refuted since, each
independently: worktree vs `git clone`, `--frozen-lockfile` vs a plain
`bun install`, the knip version (5.88.1 on both sides at the time; a 6.x
range today), the presence of a `.env`,
the turbo cache (the task is `"cache": false`, and CI logs `cache bypass`), and
the bun version (1.3.11 local vs the `packageManager`-pinned 1.3.14 — tested at
1.3.14, identical output). CI was green throughout with the same config, and
that divergence is still unexplained; it stopped mattering once the config was
made correct rather than merely quiet on one machine.
