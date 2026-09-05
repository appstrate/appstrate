<!-- SPDX-License-Identifier: Apache-2.0 -->

# Claude Code skills sync — decisions

Goal: a user installs one Claude Code plugin and, from then on, every skill of
their Appstrate organization (the pinned org + space of the CLI profile) is
available locally as `/appstrate:<skill>`, kept up to date without a manual
step. The connected plugin also supplies the organization's MCP endpoint. The
same sync feeds OpenAI Codex skills; Codex MCP is configured separately.

**How it behaves is documented in `apps/cli/README.md` → `appstrate skills`**
— flags, targets, failure modes, ownership rules, the marketplace command
string, and the cron / `launchd` fallback. This file records only the choices
behind it and what is still open.

The mechanism is entirely client-side: Claude Code plugin marketplaces accept
`source: "command"`, a locally installed tool prints the path of a directory
holding a complete plugin, and Claude Code re-runs the command once per session
in the background, reinstalling and reloading the plugin when the directory's
content hash changes. No hook, no daemon, no server change.

## Decisions

| #   | Decision                                                                                                                                                                                                                 | Rejected                                                     | Why                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Published `latest` by default; `--source draft` opt-in                                                                                                                                                                   | Draft by default                                             | Immutable, integrity-checked artifacts are what runs pin and what every skill channel ships. Authors iterating locally get `--source draft`              |
| D2  | `mode: "copy"`                                                                                                                                                                                                           | `mode: "link"`                                               | Only copy versions by file CONTENT, so a changed skill reloads mid-session. Link needs a new path to signal change and is refused on Windows             |
| D3  | `source: "command"` running the CLI                                                                                                                                                                                      | A plugin `SessionStart` hook                                 | The command source is the documented, consented, once-per-session mechanism with in-session reload; a hook fires on the cached copy                      |
| D4  | Skill directory = the frontmatter `name` when it is a legal Agent Skills name, else the slugified package `name` segment. Collision → `<scope>-<name>`, `-2`, …                                                          | The package id `@scope/name` as directory                    | The spec requires dir == `name`, and `@scope/name` is not a legal skill name. Every rename is reported on stderr                                         |
| D5  | The sync rewrites the `name` line and nothing else                                                                                                                                                                       | Injecting a description; rejecting the skill                 | PR #1252 made the platform refuse to publish a non-conforming `SKILL.md`. Legacy artifacts still sync as authored, with a note (see D5b)                 |
| D5b | A materialized `SKILL.md` failing `checkSkillMarkdown` is one stderr note                                                                                                                                                | Failing the skill, or staying silent                         | Same rule as the platform, one definition (`@appstrate/afps-shared/companion-files`). Inventing content would hide the fix from its author               |
| D6b | Before the CLI is connected, `--print-path` installs a setup plugin — one skill + a `SessionStart` hook that surfaces the remedy (fresh plugin only); the marketplace command falls back to `npx` when the CLI is absent | Failing the install with a remedy under `/plugin → Errors`   | Nobody opens that screen. A skill the model can read is where the remedy gets acted on; an existing plugin is never replaced by it                       |
| D6  | Deterministic output: no timestamps, no sync metadata, sorted entries, no `version` in `plugin.json`                                                                                                                     | Stamping a sync date                                         | The copy-mode hash IS the version; a byte-identical re-run must count as up to date                                                                      |
| D7  | Ownership ledger outside the plugin tree (`<data>/skills-sync/state.json`), recorded with the root it was written under                                                                                                  | Re-download everything each run                              | Enables the cheap diff and the only safe deletion rule for the shared `~/.agents/skills/`; the root guards against a redirected `HOME`                   |
| D8  | Targets `claude-plugin` (default), `codex`, `claude-user`                                                                                                                                                                | Claude plugin only                                           | Same materializer, different destination. `codex` is the only Codex path; `claude-user` covers `disableCommandPluginSources` and cron setups             |
| D9  | One plugin = the CLI's default profile (its pinned org + space)                                                                                                                                                          | One plugin per profile / org                                 | The marketplace entry is a static string; multi-org users switch with `appstrate org switch` or run `--profile` from cron                                |
| D10 | Marketplace = the dedicated public repo `appstrate/claude-plugins`                                                                                                                                                       | `.claude-plugin/` inside this monorepo                       | Adding a marketplace clones the repo; nobody should clone the platform monorepo for a 1 KB JSON                                                          |
| D11 | No server change                                                                                                                                                                                                         | A bulk `GET /api/packages/skills/bundle`                     | One list + N small JSON calls + downloads-on-change is fine for tens of skills; add the bulk route only if measured                                      |
| D12 | Connected plugin includes a deterministic root `.mcp.json`, derived only from the profile's instance and orgId; setup plugin has none                                                                                    | Skills only; copying CLI tokens or space headers             | Issue #1261: the existing HTTP endpoint uses browser OAuth independently of the CLI. MCP retains the org's default space; skills retain the pinned space |
| D13 | Codex MCP setup is documented through `codex mcp add` / `login`; sync continues to write skills only                                                                                                                     | A new CLI wrapper or editing Codex configuration during sync | The v1 documentation alternative in #1261 preserves existing client settings and avoids owning a second client's configuration lifecycle                 |

Writing and comparing the connected plugin use the same expected fixed files.
An instance or org change therefore updates `.mcp.json` even when every skill
is unchanged, while cached skill bytes remain reusable. A space-only change
does not alter MCP's endpoint: a skill from pinned space B can execute MCP
operations in default space A. The CLI reference documents this distinction,
OAuth, reloads, legacy connection coexistence and opt-out.

Codex supports plugins and plugin-provided MCP servers. Its current documented
plugin installation does not provide the Claude marketplace command-source
sync mechanism used here; direct skill directories plus explicit MCP setup
keep this implementation small. See [building Codex plugins](https://learn.chatgpt.com/docs/build-plugins)
and [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Still open

- **Release**: tag `cli@<version>` after merge. The marketplace command stays
  unchanged; align publication of the companion `appstrate/claude-plugins`
  README with the CLI release that includes #1261. An older installed CLI
  continues to generate a skills-only plugin until the user updates it.
- **Install consent cannot be scripted** — `-y` / `--yes` is ignored inside a
  Claude Code session, so everything downstream of the acceptance prompt
  (background re-run, in-session reload, prompt-cache invalidation) is
  unobserved. The install is a one-time step the user runs in their own
  terminal.
- **Keychain access from a non-interactive background process on macOS** —
  untested; the keyring needs the real `HOME`, so no isolated probe exists.
- **A ledger read under a different `HOME`** (cron, `launchd`, `sudo -E`) is
  unit-tested only, never exercised against a real second home.

## Follow-ups (not in this plan)

- **Integration test** (label `integration`, real API via `getTestApp`):
  publish two skills, sync, assert the tree; publish a new version, sync,
  assert only that one re-downloaded. Every server interaction is covered today
  by a stub built from real `.afps` archives
  (`apps/cli/test/helpers/skills-server.ts`); what is missing is the round-trip
  against the real routes.
- **Bulk endpoint**: extend the skills list DTO with `latest_version` +
  `latest_integrity` (one LEFT JOIN on the `latest` dist-tag) to drop the N
  version calls. Server change + OpenAPI + `generate:api`.
- **Codex MCP automation**: consider a wrapper only if the documented setup
  proves insufficient. It would need an explicit ownership and conflict policy
  for existing entries, org switches and client failures before it could write
  client configuration safely.
- **Push freshness**: a plugin `monitor` polling `GET /api/packages/skills` and
  re-running the sync — only if once-per-session proves too slow in practice.
- **Package events** on the webhook module (`package.version_created`) — would
  benefit any external sync, not just this one.
