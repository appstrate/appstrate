<!-- SPDX-License-Identifier: Apache-2.0 -->

# Claude Code skills sync — plan

Goal: a user installs one Claude Code plugin and, from then on, every skill of
their Appstrate organization (pinned org + space of the CLI profile) is
available locally as `/appstrate:<skill>`, kept up to date without manual
steps. The same sync feeds OpenAI Codex as a passenger.

> **Status (2026-09-02).** Design + feasibility verified against the code and
> the current Claude Code / Codex / Agent Skills docs. **Phase 1 is implemented
> (`appstrate skills sync`, CLI only); phases 2-4 are pending.**
> Every fact below cites its source; every decision states the alternative
> it rejected.

## 0. TL;DR

- **Mechanism**: Claude Code plugin marketplaces support
  `source: "command"` — a locally installed tool prints the path of a
  directory holding a complete plugin. Claude Code runs the command at
  install, then **once per session in the background**, and when the content
  hash changes it installs a new version and **reloads it in the running
  session** (`plugin-marketplaces.md` → "Command sources"). That is the whole
  auto-sync story. No hook, no daemon, no server change.
- **What we build**: one CLI command, `appstrate skills sync`, that
  materializes the org's published skills into a plugin directory and
  prints its path; one tiny public repo holding `marketplace.json`.
- **Server side**: nothing required. Every endpoint exists
  (`GET /api/packages/skills`, `.../versions/{spec}`,
  `/api/packages/{scope}/{name}/{version}/download` with `X-Integrity`).
- **Codex**: no session hook exists; the same command also writes
  `~/.agents/skills/`, so every Claude Code session refreshes Codex too.

## 1. Verified facts

### 1.1 Claude Code (docs fetched 2026-09-02)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                   | Source                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Marketplace plugin `source` types: relative path, `github`, `url` (git), `git-subdir`, `npm`, `archive`, **`command`**                                                                                                                                                                                                                                                                                                 | `code.claude.com/docs/en/plugin-marketplaces.md`              |
| `command` source: shape `{ "source": "command", "command": "<≤500 ASCII chars>", "timeout"?: 60 (max 600), "mode"?: "copy" \| "link" }`. Run through `sh` **from the user's home directory**. Must print **exactly one stdout line** = absolute path of a dir containing complete plugin content (`.claude-plugin/` or one of `skills/`, `commands/`, `agents/`, `hooks/`), exit 0. Requires Claude Code **v2.1.229+** | same                                                          |
| Re-run cadence: at install/update; **once per session, in the background, shortly after start**; at startup or `/reload-plugins` when the cached version is missing. Skipped when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set                                                                                                                                                                                    | same, "When Claude Code re-runs the command"                  |
| `mode: "copy"` (default): directory copied into the versioned cache, **version = hash of contents**, identical re-run = up to date. Limits 256 MiB / 20 000 entries. On changed hash: new version installed and **reloaded in the running interactive session** (same components as `/reload-plugins`); if that would invalidate the prompt cache, the user is prompted to run `/reload-plugins` instead               | same, "Copy mode and link mode", "Background re-run behavior" |
| `mode: "link"`: files used in place, version derived from the **real path + top-level entries, not file contents** → content changes do not trigger a reload; not supported on Windows                                                                                                                                                                                                                                 | same                                                          |
| Consent: the exact command string is shown and recorded at install; background runs execute only the accepted string; changing the string stops re-runs until the user re-accepts via `claude plugin update`. Orgs can block with `disableCommandPluginSources`                                                                                                                                                        | same, "Security and user consent"                             |
| Plugin skills layout: `skills/<dir>/SKILL.md`, one level. Plugin skill command = frontmatter `name` (or dir name), namespaced `/<plugin>:<name>`; bare `/<name>` also works unless taken                                                                                                                                                                                                                               | `skills.md` → "How a skill gets its command name"             |
| Plugin `name` is the only required manifest field. `version` optional; for a `command` source the hash wins regardless                                                                                                                                                                                                                                                                                                 | `plugins-reference.md`                                        |
| Live change detection covers `~/.claude/skills/` and `.claude/skills/` (SKILL.md text). Plugin skills reload via the mechanism above or `/reload-plugins`                                                                                                                                                                                                                                                              | `skills.md` → "Live change detection"                         |
| Claude Code accepts every Agent Skills spec field plus its own (`disable-model-invocation`, `user-invocable`, `allowed-tools`, `paths`, …); unknown fields are tolerated in Claude Code, rejected only by claude.ai uploads                                                                                                                                                                                            | `skills.md` frontmatter table                                 |
| Agent Skills spec: `name` 1–64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen, **must match the parent directory name**; `description` 1–1024 chars                                                                                                                                                                                                                                                             | `agentskills.io/specification`                                |
| Plugins can also declare `mcpServers`, `hooks`, and background `monitors`                                                                                                                                                                                                                                                                                                                                              | `plugins-reference.md`                                        |

### 1.2 Codex CLI (docs fetched 2026-09-02)

| Fact                                                                                                                                                               | Source                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Skills load from `$CWD/.agents/skills`, parents up to repo root, `$REPO_ROOT/.agents/skills`, **`$HOME/.agents/skills`**, `/etc/codex/skills`, scanned per session | `learn.chatgpt.com/docs/build-skills` |
| Frontmatter `name` + `description` mandatory; per-skill enable/disable via `[[skills.config]]` in `~/.codex/config.toml`                                           | same                                  |
| No documented session-start hook or command-source plugin equivalent                                                                                               | same (absence)                        |

### 1.3 Appstrate (this repo)

| Fact                                                                                                                                                                                                                                                                                                          | Where                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A skill is a `packages` row (`type = 'skill'`, id `@scope/name`); `draft_content` **is** `SKILL.md`; the mutable artifact and every published version are ZIPs in object storage, never per-file rows                                                                                                         | `packages/db/src/schema/packages.ts:76-152`, `packages/core/src/package-files.ts:96-101`                                   |
| Published versions are immutable snapshots with SRI `integrity`; `latest` dist-tag auto-managed on publish; yanked versions excluded from tag/range resolution                                                                                                                                                | `apps/api/src/services/package-versions.ts:147-153`, `packages/core/src/semver.ts:111-133`                                 |
| List: `GET /api/packages/skills` → installed-in-space org skills + system skills (there are **no** system skills today: `system-packages/` holds only integrations + one mcp-server). DTO has `id`, `name`, `description`, `version` (draft manifest), `updatedAt`, `lock_version` is **not** in the list DTO | `apps/api/src/services/package-items/crud.ts:277-345`                                                                      |
| Version detail: `GET /api/packages/skills/{scope}/{name}/versions/{spec}` — `spec` = exact \| dist-tag (`latest`) \| semver range → `{ version, manifest, content, integrity, yanked, dist_tags }`                                                                                                            | `apps/api/src/routes/packages.ts:1209-1240`                                                                                |
| Download: `GET /api/packages/{scope}/{name}/{version}/download` → the `.afps` ZIP, headers `X-Integrity`, `X-Yanked`; same `spec` resolution; gated by `hasPackageAccess` (installed in the request's space) + `skills:read`                                                                                  | `apps/api/src/routes/packages.ts:2346-2397`                                                                                |
| Auth pipeline: `Bearer ask_…` API key or device-flow JWT, `X-Org-Id` / `X-Space-Id` headers. The CLI already sends all three (`apiFetchRaw`)                                                                                                                                                                  | `apps/api/src/lib/auth-pipeline.ts:115-230`, `apps/cli/src/lib/api.ts:261-324`                                             |
| ZIP layout: flat root, `manifest.json` + `SKILL.md` (frontmatter `name` required, `description` tolerated missing) + any files; single wrapper folder stripped on import; `RECORD` is a packaging artifact                                                                                                    | `packages/afps-shared/src/companion-files.ts:117-133`, `apps/api/src/services/skill-zip.ts:14-73`                          |
| Appstrate validates only that frontmatter `name` is non-empty (`extractSkillMeta`) — **not** the Agent Skills charset. The `@scope/name` id itself is slug-only (`SLUG_PATTERN`)                                                                                                                              | `packages/core/src/validation.ts:656-686`, `packages/core/src/naming.ts:14-16`                                             |
| Unzip helpers with decompression bounds already exist in core and are bundled into the CLI (`@appstrate/core/zip`: `parsePackageZip`, `unzipArtifact`, 10 MB / 50 MB limits)                                                                                                                                  | `packages/core/src/zip.ts:110-267`                                                                                         |
| A skill materializer exists for the Pi runtime (`materialisePackage`) but lives in `packages/runner-pi`, not a CLI dependency, and has **no path-traversal guard** — do not reuse as-is                                                                                                                       | `packages/runner-pi/src/bundle-extensions.ts:63-77`                                                                        |
| CLI: commander, profiles in `$XDG_CONFIG_HOME/appstrate/config.toml` (`instance`, `orgId`, `spaceId`), tokens in the OS keyring with 0600-file fallback, IO seam (`CommandIO`) + deps injection for tests, published to npm as `appstrate` (`bin`) and as a compiled binary via `get.appstrate.dev`           | `apps/cli/src/lib/config.ts`, `apps/cli/src/lib/keyring.ts`, `apps/cli/src/commands/space.ts`, `apps/cli/scripts/build.ts` |
| No webhook / `pg_notify` event exists for package changes (webhooks enum is `run.*` only)                                                                                                                                                                                                                     | `apps/api/src/modules/webhooks/service.ts:42-53`                                                                           |
| No existing export-to-Claude/Codex code anywhere (grep `.claude/skills`, `marketplace.json`, `.agents/skills` → 0 hits)                                                                                                                                                                                       | —                                                                                                                          |

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                          | Rejected alternative                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Published `latest` by default**, `--source draft` opt-in                                                                                                                                                                                                                                        | Draft by default                                            | Immutable + integrity-checked artifacts are what every skill/plugin distribution channel ships (Claude marketplaces hash/pin, npm, agentskills registries); it is also what Appstrate agents run (runs pin a version, never the draft). "I edited a skill" therefore means "I published a version" — same discipline as the platform. Authors iterating on a skill get `--source draft` on their own machine |
| D2  | **`mode: "copy"`**                                                                                                                                                                                                                                                                                | `mode: "link"`                                              | Copy is the only mode whose version follows file **contents**, so a new/changed skill reloads mid-session; link needs a new path to signal change and is refused on Windows. Skill payloads are KB-sized, far under 256 MiB / 20 000 entries                                                                                                                                                                 |
| D3  | **`source: "command"`** running the CLI, no SessionStart hook, no daemon                                                                                                                                                                                                                          | Plugin `SessionStart` hook writing into `~/.claude/skills/` | The command source is the documented, consented, once-per-session mechanism with in-session reload; a hook would fire on the cached copy and could not update the plugin's own skills; writing into the user's personal skills dir mixes managed and hand-written content                                                                                                                                    |
| D4  | **Plugin skill dir + frontmatter `name` = the Agent Skills slug** derived from the frontmatter `name`, falling back to the package `name` segment. Collision inside the space → second one becomes `<scope>-<name>`, then `-2`, `-3`, … until free (the `<scope>-<name>` form can itself collide) | Package id `@scope/name` as dir                             | The spec requires dir == `name`, and the command name comes from `name`; `@scope/name` is not a legal skill name. Collisions are rare (one space) and the deterministic rename is reported on stderr                                                                                                                                                                                                         |
| D5  | **Frontmatter rewritten only when needed**: `name` replaced by the slug when it differs; `description` injected from the manifest when missing (Codex and the spec require it). Everything else passes through verbatim                                                                           | Reject non-conforming skills                                | Appstrate accepts names the spec rejects; refusing would make the sync partial for existing orgs                                                                                                                                                                                                                                                                                                             |
| D6  | **Deterministic output**: no timestamps, no sync metadata inside the plugin dir; sorted entries; `plugin.json` without `version`                                                                                                                                                                  | Stamping a sync date                                        | The copy-mode hash **is** the version; a byte-identical re-run must count as "up to date"                                                                                                                                                                                                                                                                                                                    |
| D7  | **State file outside the plugin dir** (`<data>/skills-sync/state.json`): per target, the set of managed dirs + `{packageId, version, integrity}`                                                                                                                                                  | Re-download everything each run                             | Enables the cheap diff (§3.4) and safe deletion of only dirs we created (critical for the shared `~/.agents/skills/`)                                                                                                                                                                                                                                                                                        |
| D8  | **Targets**: `claude-plugin` (default, prints the path), `codex` (`~/.agents/skills/`), `claude-user` (`~/.claude/skills/`)                                                                                                                                                                       | Claude plugin only                                          | Same materializer, different destination. `codex` is the only Codex path; `claude-user` is the fallback when an org blocks command sources (`disableCommandPluginSources`) or for cron-driven setups                                                                                                                                                                                                         |
| D9  | **One plugin = the CLI's default profile** (its pinned org + space)                                                                                                                                                                                                                               | One plugin per profile/org                                  | The marketplace entry is a static string; multi-org users switch with `appstrate org switch` or run `--profile` targets by cron. Revisit if asked                                                                                                                                                                                                                                                            |
| D10 | **Marketplace = dedicated public repo `appstrate/claude-plugins`** with `.claude-plugin/marketplace.json` only                                                                                                                                                                                    | `.claude-plugin/` inside the monorepo                       | Adding a marketplace clones the repo; nobody should clone the platform monorepo to get a 1 KB JSON                                                                                                                                                                                                                                                                                                           |
| D11 | **No server change in v1**                                                                                                                                                                                                                                                                        | Bulk `GET /api/packages/skills/bundle`                      | 1 list + N small JSON calls + downloads-on-change is fine for tens of skills; add the bulk route only if measured (§6)                                                                                                                                                                                                                                                                                       |
| D12 | **Skills only**. No `mcpServers` in the generated plugin in v1                                                                                                                                                                                                                                    | Ship the org MCP endpoint too                               | Out of the asked scope; listed as follow-up (§6) because it is nearly free                                                                                                                                                                                                                                                                                                                                   |

## 3. Design

### 3.1 CLI command

```
appstrate skills sync [--target claude-plugin|codex|claude-user]... [--source published|draft]
                      [--print-path] [--dry-run]
```

- `sync` is the whole command surface. `skills list` and a `--json` flag were
  both dropped before implementation: the catalogue is already listable with
  `appstrate api GET /api/packages/skills`, and nothing consumes a machine-
  readable sync report — the one machine reader is Claude Code, and it reads a
  bare path off stdout. They come back the day something asks for them.
- `--target` repeatable; default `claude-plugin`. `--print-path` prints the
  plugin dir as the **only** stdout line (everything else goes to stderr) —
  that is the flag the marketplace command uses. It requires
  `--target claude-plugin` and REFUSES `--dry-run`: a dry run writes no
  plugin, so the path it would print names a directory the run did not
  produce. Without it, human output.
- Non-interactive by construction: never prompts. Missing login, missing
  org/space pin, expired refresh token → exit 1 with a one-line remedy on
  stderr (`Run: appstrate login`). Claude Code surfaces it in `/plugin` →
  Errors.
- Marketplace command string (must stay stable, see consent rule):
  `appstrate skills sync --target claude-plugin --target codex --print-path`
  with `"timeout": 120`. Shorter than 500 chars, no 4-space runs.
- Requires `appstrate` on `PATH` from a non-login `sh` started in `$HOME`.
  Both install channels (npm global, `get.appstrate.dev`) put it on PATH;
  document the check (`sh -lc 'command -v appstrate'` is **not** what runs —
  test with `sh -c`).

### 3.2 Generated plugin directory (target `claude-plugin`)

```
$XDG_DATA_HOME/appstrate/claude-plugin/        # ~/.local/share/appstrate/… on macOS/Linux
├── .claude-plugin/
│   └── plugin.json          # { "name": "appstrate", "description": "<fixed, org-independent>" }  — no version
├── README.md                # what this is, "managed by appstrate skills sync, do not edit"
└── skills/
    ├── <slug>/
    │   ├── SKILL.md         # frontmatter normalized per D5
    │   └── …                # every other ZIP entry except manifest.json, RECORD
    └── <slug-2>/…
```

`manifest.json` is dropped from the skill dir (it is Appstrate packaging, not
skill content) — its `description`/`display_name` are consumed for D5 only.
The plugin is named `appstrate`, so skills are `/appstrate:<slug>`.

The plugin description is a fixed string and deliberately does NOT name the
org: for a `command` source the content hash IS the version, so an org rename
would rewrite `plugin.json`, change the hash, and make Claude Code install a
"new" plugin version for a change that touched no skill.

### 3.3 Other targets

- `codex`: `~/.agents/skills/<slug>/…`, same content. Managed dirs recorded
  in the state file; a dir not in the state file is never touched.
- `claude-user`: `~/.claude/skills/<slug>/…`, same rule. Live change detection
  applies, no plugin needed.

### 3.4 Sync algorithm

0. Take `<data>/skills-sync/lock` (an atomic `mkdir`; wait up to 60 s, reap a
   lock older than 10 min, else exit 1 with `Another appstrate skills sync is
running`). The command runs unattended once per session, so two Claude Code
   sessions opened together WILL overlap — and two concurrent runs race the
   atomic swaps and last-writer-wins the ledger.
1. Resolve profile → `instance`, `orgId`, `spaceId` (fail fast if unpinned).
2. `GET /api/packages/skills` → candidates (already filtered to the space).
   Skip `source: "system"` rows defensively (none exist today).
3. For each candidate, `GET /api/packages/skills/{scope}/{name}/versions/latest`
   (or the draft detail when `--source draft`) → `{version, integrity}`.
   404 = never published → skip with a stderr note.
   Concurrency: 8 in flight (the route family is rate-limited at 50/window).
4. Diff against `state.json`: unchanged `integrity` → keep; changed or new →
   `GET /api/packages/{scope}/{name}/{version}/download`, verify bytes against
   `X-Integrity` with `verifyArtifactIntegrity` (already used by
   `run/bundle-fetch.ts`), then `unzipArtifact` + `stripWrapperPrefix` under
   the same 50 MB decompression ceiling `parsePackageZip` applies —
   `parsePackageZip` itself is NOT used: it re-validates the embedded manifest
   with the author-input policy, which would make a published artifact the
   platform already accepted unsyncable over a manifest key nobody can rewrite.
   Then **reject entries that are absolute, contain `..`, or are symlinks**.
5. Compute slugs + collisions (D4), normalize `SKILL.md` (D5).
6. Write atomically per target: build the target tree under a dot-prefixed
   `<root>/.appstrate-staging/`, then swap (`rename`) so a background run that
   dies mid-way never leaves a half plugin that Claude Code would hash as a new
   version — and never leaves a scannable half-skill inside `~/.agents/skills/`.
   On the shared targets, a destination the state file does not claim is
   **refused, not overwritten**: reported on stderr, skipped, left out of the
   ledger. The atomic swap deletes what it replaces, so writing over
   hand-written content would be silent data loss.
7. Remove managed dirs whose package disappeared from the list. A skill whose
   refresh failed keeps the version already on disk, ledger entry included.
8. Persist `state.json` (in a `finally`, so a target that threw mid-swap is
   still recorded); print the path (or the report).

Exit code: without `--print-path`, any failure exits 1. With `--print-path`,
only a whole-run failure does — a non-zero exit makes Claude Code discard the
run, so one unpublished skill must not cost the user a correct plugin.

`--source draft` uses `GET .../skills/{scope}/{name}` (`content`, `manifest`,
`lock_version`) for `SKILL.md` and `GET /api/packages/{scope}/{name}/files`

- `files/content` for supporting files, keyed by the files-index `ETag`.

### 3.5 Marketplace repo `appstrate/claude-plugins`

```
.claude-plugin/marketplace.json
README.md
```

```json
{
  "name": "appstrate",
  "owner": { "name": "Appstrate" },
  "plugins": [
    {
      "name": "appstrate",
      "description": "Your Appstrate organization's skills, synced every session",
      "source": {
        "source": "command",
        "command": "appstrate skills sync --target claude-plugin --target codex --print-path",
        "timeout": 120,
        "mode": "copy"
      }
    }
  ]
}
```

User flow: `appstrate login` → `claude plugin marketplace add appstrate/claude-plugins`
→ `claude plugin install appstrate@appstrate` (shows and records the command).

## 4. Phases

### Phase 1 — `appstrate skills sync` (CLI only)

Files:

- `apps/cli/src/commands/skills.ts` — `skillsSyncCommand`, options + a trailing `CommandIO` seam (mirror `space.ts`).
- `apps/cli/src/lib/skills-sync/` — `plan.ts` (list + version resolution + diff), `materialize.ts` (ZIP → files, slug, frontmatter normalization, traversal guard), `targets.ts` (dest resolution per target, atomic swap, managed-dir deletion), `state.ts` (state file read/write, schema-validated with Zod).
- `apps/cli/src/lib/config.ts` — add `getDataDir()` (`XDG_DATA_HOME` → `~/.local/share/appstrate`).
- `apps/cli/src/cli.ts` — wire `skills` group.
- `apps/cli/README.md` + `docs/cli/` — new section; state-file and target layout; the marketplace command string; "not logged in" failure mode.
- `apps/cli/CHANGELOG` entry (whatever the CLI release notes convention is — check `publish-cli.yml` and the latest `cli@` tag).

Tests (`apps/cli/test/skills-*.test.ts`, bun:test, deps injection, no `mock.module`):

- materialize: deterministic bytes for the same ZIP; `manifest.json`/`RECORD` dropped; traversal/absolute/symlink entries rejected; frontmatter untouched when conforming, `name` rewritten when not, `description` injected when missing.
- slug: package `@acme/pdf-tools` with `name: PDF Tools` → `pdf-tools`; collision → `acme-pdf-tools`; stable order.
- plan/diff: unchanged integrity → no download; removed package → dir deleted only if managed; foreign dir in `~/.agents/skills` untouched.
- command: `--print-path` prints exactly one line on stdout, everything else on stderr; unpinned space → exit 1 with remedy; 404 on `versions/latest` → skipped, not fatal.
  Acceptance: `cd apps/cli && bun test`, `bun run check` green; manual:
  `appstrate skills sync --target claude-user` then `/skills` in Claude Code
  lists them.

### Phase 2 — Marketplace + plugin validation

- Create `appstrate/claude-plugins` with the JSON above; `claude plugin validate .`.
- Validate on macOS + Linux: install → consent screen shows the command;
  session start → background run; publish a skill version → within a new
  session, notification "plugin reloaded" or `/reload-plugins` prompt;
  `/appstrate:<slug>` works. Record the observed behaviour in this file.
- Confirm the keychain path: background run from `sh -c` in `$HOME`, no TTY,
  after a CLI self-update (new binary) — macOS may show a Keychain ACL dialog
  the first time. If it does, document it in the README (one-time) and make
  sure the CLI fails within the timeout instead of hanging on the dialog.
- Windows: `mode: "copy"` works; check `%APPDATA%` paths and that `sh` here is
  `cmd.exe` (command string is shell-neutral: no quotes, no `&&`).

### Phase 3 — Codex + fallback docs

- `codex` target is already produced by the marketplace command. Document
  the Codex-only path: `appstrate skills sync --target codex` on a `launchd`
  / cron entry, or after `appstrate login`.
- `[[skills.config]]` interplay: we never write `~/.codex/config.toml`; a
  user disabling one of our skills there keeps their choice across syncs
  because paths are stable.

### Phase 4 — Release

- CLI: bump, tag `cli@<version>`, push (the npm channel is the only way the
  marketplace command reaches users; the curl channel follows the platform
  release). Mention the Claude Code minimum (v2.1.229) in the release notes.

## 5. Risks and what to test first

| Risk                                                                            | Mitigation / test                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background run silently skipped (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`)    | Documented; `claude plugin update appstrate@appstrate` is the manual path                                                                                                                           |
| Org policy blocks command sources                                               | `--target claude-user` + cron, documented                                                                                                                                                           |
| Prompt-cache invalidation turns the auto-reload into a `/reload-plugins` prompt | Expected per docs; still zero manual sync                                                                                                                                                           |
| Keychain dialog from a non-interactive background process on macOS              | Phase 2 test; CLI must not block past the timeout                                                                                                                                                   |
| Half-written plugin dir hashed as a "version"                                   | Atomic swap (§3.4 step 6)                                                                                                                                                                           |
| Deleting user content in `~/.agents/skills` or `~/.claude/skills`               | State-file ownership; never delete unmanaged dirs; `--dry-run`                                                                                                                                      |
| Skill names that are Claude built-ins (`help`, `review`…)                       | Namespaced `/appstrate:help` still works; bare name yields to the built-in — documented, no rename                                                                                                  |
| Rate limit 50/window on package routes with large orgs                          | Concurrency 8; downloads only on change; bulk route if measured (§6)                                                                                                                                |
| Path traversal / zip bombs in a published skill                                 | `unzipArtifact` + `stripWrapperPrefix` under `PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES` + explicit entry guard; the runner-pi materializer's lack of a guard is out of scope here but worth its own issue |

## 6. Follow-ups (not in this plan)

- **Integration test** (label `integration`, real API via `getTestApp`):
  publish two skills, sync, assert the tree; publish a new version, sync,
  assert only that one re-downloaded. Phase 1 shipped without it — every
  server interaction is covered by a stub built from real `.afps` archives
  (`apps/cli/test/helpers/skills-server.ts`), so what is missing is the
  round-trip against the real routes, not the behaviour.

- **Bulk endpoint**: extend the skills list DTO with `latest_version` +
  `latest_integrity` (one LEFT JOIN on the `latest` dist-tag) to drop the
  N version calls. Server change + OpenAPI + `generate:api`.
- **Org MCP in the plugin**: emit `.mcp.json` with
  `{ "appstrate": { "type": "http", "url": "<instance>/api/mcp/o/<orgId>" } }`
  (RFC 9728 discovery already served) so the plugin also gives Claude Code the
  org's tools. Changes need `/reload-plugins`, so generate it once and keep it
  byte-stable.
- **Push freshness**: a plugin `monitor` polling `GET /api/packages/skills`
  every few minutes and re-running the sync — only if once-per-session proves
  too slow in practice.
- **Package events** on the webhook module (`package.version_created`) —
  would benefit any external sync, not just this one.
