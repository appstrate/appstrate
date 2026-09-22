# Skills in the chat

Supersedes PR #851, #1126 and #1165 and implements issue #1309. One mechanism,
four sources, delivered in four phases (one commit each).

## Problem

The chat can _name_ skills but never _use_ one. `packages/module-chat/src/prompt.ts`
renders a 15-entry catalogue titled "Skills you can attach to an agent"; the
SKILL.md body is never read. The chat's Pi session is deliberately resource-free
(`pi-chat/resource-loader.ts`: `noSkills`, no package discovery, no builtin
tools, cwd `/tmp`), so Pi's native skill directory cannot be used. Nothing
ships as a system skill today, and there is no way to hide a package from the
catalogue.

## Design

```
effective skills(turn) =
    platform defaults      (module-chat constant, system packages, unlisted)
  ∪ pinned on the session  (chat_session_skills)
  ∪ mentioned in a message (`/skill` directive in the user text)
  (+ the space catalogue when discovery is `auto`)
```

Two levels of loading, as in the Agent Skills spec, Claude Code and Codex:

- **Index** — name + description in the system prompt, deterministic order.
  Used for platform defaults, pinned skills and the catalogue. The body is
  loaded on demand by the model through `invoke_operation` → `getSkill`
  (scope/name path params, no version selector: the platform's single
  definition-read rule applies — the author's draft when writable, else the
  latest published version).
- **Direct load** — the SKILL.md body enters the _user turn text_, never the
  system prompt, so the cached prefix survives. Used for `/skill` mentions.
  Mentions are re-resolved on every turn from the persisted directive, so a
  loaded body stays in the conversation history (Claude Code semantics); a
  second mention of an already-loaded skill yields a one-line
  "already loaded" note instead of a second copy.

Prompt cache: the system prompt is ONE `cache_control` block (`prompt.ts`).
Everything the resolver renders there must be byte-identical across turns for
the same session state: sorted by package id, no clocks, no per-turn counters.
Changing pins or discovery is an explicit user act and may miss the cache once.

Visibility (`unlisted`) is discoverability only, never authorization. Access is
always re-checked at turn time against `skills:read` and package accessibility;
an inaccessible pinned skill is skipped with one deterministic notice line.

Discovery mode (per session, persisted, default `auto`):

| mode        | index                         | model guidance                                     |
| ----------- | ----------------------------- | -------------------------------------------------- |
| `auto`      | defaults + pinned + catalogue | load when relevant; `listSkills` for the long tail |
| `on_demand` | defaults + pinned             | no catalogue; call `listSkills` only when asked    |
| `manual`    | pinned only                   | load nothing the user did not pin or mention       |

This is a context-budget control, not a security boundary: `invoke_operation`
stays generic and RBAC-gated.

Decisions taken (with alternatives rejected):

- No `_meta` "assistant skill" marker (#1165): a platform default is a constant
  list in module-chat; the package does not describe its consumer.
- No body-in-system-prompt mode (Cursor "Always"): costs the body every turn
  and busts the single cache block. Pin + mention once gives the same result.
- Catalogue description = `manifest.description` (what the hint listing already
  reads); the SKILL.md frontmatter description addresses the run-time agent.
- Ordering of the catalogue: pinned/defaults are outside the cap; the cap
  itself stays 15 in `packageListingOrder()` order. No recency ranking — it
  would reorder the index between turns.
- Mentions use `/` (Claude Code convention); `@` is reserved for entities and
  collides with `@scope/name` ids.
- Mentioned skills are NOT auto-pinned and pinned skills are NOT propagated to
  inline sub-agents; the model sees them in its index and attaches them when
  relevant.

## Phase 1 — `unlisted` visibility

`_meta["dev.appstrate/visibility"] = { "level": "unlisted" }` (AFPS §10.1
vendor extension; `_meta` already validated and preserved by core).

- One SQL predicate `listedFilter()` next to `orgOrSystemFilter` /
  `notEphemeralFilter` (`apps/api/src/services/package-filters.ts` or wherever
  those live): `draft_manifest #>> '{_meta,dev.appstrate/visibility,level}' IS DISTINCT FROM 'unlisted'`.
  Applied in every listing query that feeds a catalogue: `listOrgItems`
  (`package-items/crud.ts`), `getPackageLibrary` (`package-library.ts`),
  `listActivePackageHints` (`space-packages.ts`). In SQL, not in JS, so the
  hint cap and `total` stay honest.
- A TS twin `isUnlisted(manifest)` in `apps/api/src/lib/package-visibility.ts`
  only if a JS-side reader needs it; otherwise do not add it.
- Exact-id reads (`getSkill`, `getAgent`, dependency resolution, version
  resolution) are untouched.
- Tests: unit for the predicate; integration proving an unlisted skill is
  absent from `GET /api/packages/skills`, `GET /api/library`, `/api/me/context`
  `skills`, and readable by `GET /api/packages/skills/{scope}/{name}`.

## Phase 2 — resolver, index, loading, platform default skills

Server (apps/api):

- `GET /api/me/context?skills=<comma-separated ids>` resolves the named skills
  by exact id for the caller in the current space (system packages and any
  package `activePackagesFilter` accepts, listed or not; `skills:read`
  required, else empty). Response gains `requested_skills: [{package_id,
display_name, description, version, source}]` (sorted by package_id) and
  `unresolved_skills: string[]`. Unknown/inaccessible ids land in
  `unresolved_skills`, never 4xx. OpenAPI + generated types updated.

Module-chat:

- `src/skills.ts`: `PLATFORM_DEFAULT_SKILLS` (`@appstrate/copilot`,
  `@appstrate/web-search`, `@appstrate/connector-choice`), the
  `SkillDiscovery` enum, and a pure `resolveChatSkills({ discovery, pinned,
defaults, requested, unresolved, catalogue })` → `{ indexed, notices,
catalogue }` with deterministic ordering. Unit-tested.
- `buildCallerContextBlock` passes `skills=defaults ∪ pinned` on the dispatch
  (phase 2 has no pins yet: defaults only, discovery `auto`).
- `formatCallerContext` renders `## Skills` with one entry per indexed skill
  (`- \`@scope/name\` (v1.2.0) — Display name: description`), then the
catalogue block when discovery is `auto`, then notices.
- `buildSystemPrompt` gains the loading rules: load before acting when a skill
  clearly matches, one at a time, via `invoke_operation` `getSkill` with
  `scope` / `name` (keep the `@`); do not reload a skill whose body is already
  in the conversation; when authoring an agent, attach relevant skills under
  `dependencies.skills` (existing sentence, kept). The "attach to an agent"
  wording is author-gated as today; the load rules are not.
- Byte-identical rendering across turns for the same inputs: test with the
  existing `opts.now` seam pattern (`caller-context.test.ts`).

System skills (`scripts/system-packages/skill-<name>-1.0.0/`, built into
`system-packages/*.afps` by `bun run scripts/build-system-packages.ts`; the
`--check` drift gate runs in `bun run check`):

- `@appstrate/copilot` — agent-creation copilot (interview → propose →
  assemble). `@appstrate/web-search` — search/read the web through an inline
  run. `@appstrate/connector-choice` — pick the right connector variant.
- Every instruction MUST match the current platform: `run_and_wait`
  (`kind:"inline"` / `kind:"agent"`), `appfile://` + `context_files`,
  `publish_file`, `outputs/`, `invoke_operation`/`describe_operation`. No
  `wait_for_run`, no `POST /api/runs/inline`, no `report`, no
  `document://`, no package that does not ship (only `@appstrate/firecrawl`
  ships for web access). Read `packages/module-chat/src/prompt.ts` and
  `apps/api/src/modules/mcp/router.ts` first.
- `manifest.json`: `type: "skill"`, `schema_version` as other system packages,
  `display_name`, `description` (≤ 1024 chars, written for the chat: what it
  does AND when to load it), `license: "Apache-2.0"`, `_meta` unlisted.
- `SKILL.md` frontmatter: `name`, `description` — QUOTED YAML strings (prod
  has 17 skills with unparseable frontmatter from bare colons). Body ≤ 300
  lines, French like the existing content, no personal instance references.
- Conformance: `bun test packages/runner-pi/test/skill-frontmatter-parity.test.ts`
  and whatever gate `#1252` added must pass on the new archives.

## Phase 3 — pins, discovery mode, picker

Schema (migration `0069`, hand-written SQL + snapshot + journal like 0067/0068;
`verify:no-migration-dml` must pass):

- `chat_sessions.skill_discovery text NOT NULL DEFAULT 'auto'` + CHECK in
  (`auto`, `on_demand`, `manual`).
- `chat_session_skills (session_id text NOT NULL REFERENCES chat_sessions ON DELETE CASCADE, package_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (session_id, package_id))`.
  `package_id` is the `@scope/name` id (same as `packages.id`); no FK, a
  deleted package is an unresolved pin skipped at turn time.

Routes (module-chat `routes.ts`, all `chat:write` / `chat:read`):

- `GET /api/chat/skills` → `{ skills: [{package_id, display_name, description,
version, source: "platform" | "space"}] }`: the platform defaults resolved
  through `/api/me/context?skills=` plus the space catalogue
  (`GET /api/packages/skills`, dispatched in-process, first 100). One list
  for the picker and the `/` popover.
- `PUT /api/chat/sessions/:id/skills` body `{ skill_discovery, pinned_skills:
string[] }` (Zod: enum + array of `@scope/name`, max 20, deduped). Calls
  `ensureSession` first (a fresh client-minted id has no row yet; the write
  creates it exactly like the first turn does), then replaces the pin set
  and the mode in one transaction, `notifySessionUpdate`, 204.
- `toSessionDto` gains `skill_discovery` and `pinned_skills` (sorted). The
  list route may leave `pinned_skills` out; the detail route includes it.
- `chat-stream.ts`: read `skill_discovery` + pins from the session row (the
  `ensureSession` round trip already returns the row — extend it rather than
  add a query), pass them to the resolver. Turn body gains nothing.

UI (module-chat `ui/`):

- `skills-picker.tsx` in `composerSlot` next to `ModelSelect`: a button with
  the pinned count; popover with the discovery mode (3 options, one line of
  hint each) and the skill list from `GET /api/chat/skills` with a pin
  checkbox per row. Writes go through `PUT …/skills` with optimistic React
  Query update; the session query key is invalidated.
- i18n keys in `apps/web/src/locales/{fr,en}/chat.json` (flat dotted keys),
  `t` from `useChatHost()`.
- Follow `agent-authoring-toggle.tsx` / `model-select.tsx` for look and feel.

## Phase 4 — `/skill` mention

Directive syntax in the user text (assistant-ui directive shape, one per
mention): `:skill[/name]{id=@scope/name}`. The label is what the chip shows;
`id` is what the server resolves. Regex on the server is strict
(`@[a-z0-9-]+/[a-z0-9-]+`), anything else stays prose.

Server (module-chat):

- `src/skill-mentions.ts`: `parseSkillMentions(text)`, and
  `messagesWithSkillsAsText(messages, bodies)` mirroring
  `attachments.ts`: replaces each directive with
  `[Skill @scope/name (v…) loaded]\n<body>` the first time an id appears in
  the history, and `[Skill @scope/name already loaded above]` afterwards.
  Unresolved → `[Skill @scope/name could not be loaded: <reason>]`.
- Resolution: the union of mentioned ids across ALL user messages, fetched
  through in-process dispatch of `getSkill` in parallel with phase B of the
  preamble (`chat-stream.ts`), `skills:read` re-checked by the route itself.
  Body cap 32 KiB per skill (truncate with a marker). Applied inside
  `buildStructuredPiTurn` next to `messagesWithAttachmentsAsText`.
- The persisted user message keeps the raw directive text (audit trail).

UI:

- `ComposerPrimitive.Unstable_TriggerPopover` char `/` with
  `unstable_useMentionAdapter` over `GET /api/chat/skills` (shared hook with
  the picker), `.Directive` formatter producing the syntax above. Wrap the
  `unstable_*` API in ONE component (`skill-mention.tsx`) so a library change
  touches one file.
- User bubble: render `:skill[…]{…}` directives as chips (parse in
  `thread.tsx` `UserMessage`, reuse the parser from `skill-mentions.ts`).

## Out of scope (deliberately)

- Per-space default skills (inherit into new sessions) — the resolver's
  `defaults` input is where they would plug in.
- Exposing platform defaults to external MCP clients through `get_me`.
- A dedicated `load_skill` MCP tool — measure `getSkill` first.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165) —
  separate PRs.
