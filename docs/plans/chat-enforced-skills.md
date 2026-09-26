# Space-enforced skills in the chat

Implements issue #1586. Follows #1494 (`docs/plans/chat-skills.md`).

## Goal

A space imposes skills on every chat conversation held in it: injected in full
in every turn, whatever the skill mode, whatever the member's `skills:*`
grants, not removable from the composer. Enforcement is a property of the
placement row, so the activation rule stays the one rule.

## Decisions

| Question                                | Decision                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Where                                   | `space_packages.chat_enforced`, skills only                              |
| Gate                                    | the PATCH's `configure` gate = `skills:write` in the space               |
| Content                                 | latest published version (`latest` dist-tag), never the draft            |
| Authority                               | platform, not the caller: a new `PlatformServices` entry                 |
| Load failure                            | the turn is refused (503), before anything is persisted                  |
| Cap                                     | `MAX_ENFORCED_SKILLS = 3`, total within `SKILLS_CONTENT_BUDGET_CHARS`    |
| Precedence                              | enforced first, then chosen; a pin naming an enforced skill is dropped   |
| Names for members without `skills:read` | visible, through a chat-module read                                      |
| Audit                                   | `package.chat_enforced` / `package.chat_released`, on actual change only |

## Steps

Each step is one commit, green on its own (`bun run check` + the tests it
touches).

### 1. Schema — migration `0075`

- `packages/db/src/schema/packages.ts`: `chatEnforced: boolean("chat_enforced").notNull().default(false)`
  on `spacePackages`, with a comment: skills only, read by the chat with
  platform authority, kept across deactivation like every placement setting.
- `bun run db:generate` → `packages/db/drizzle/0075_space_packages_chat_enforced.sql`
  - snapshot; `packages/db/schema-catalog.txt` gains one line.
- No data rewrite: the default is the current behaviour.

### 2. Shared constants and the core contract

- `packages/core/src/chat-contract.ts`:
  - `CHAT_SKILLS_CONTENT_BUDGET_CHARS = 64_000` and `MAX_ENFORCED_CHAT_SKILLS = 3`
    — moved here because the API's PATCH and the chat module must agree on
    them; `module-chat/src/skills.ts` re-imports instead of defining.
  - `interface EnforcedChatSkill { packageId; displayName; version: string | null; content: string | null }`
    — `content: null` = enforced but no published version readable now
    (deleted, unreadable archive): the chat renders a notice.
- `packages/core/src/module.ts` `PlatformServices`:
  `loadEnforcedChatSkills(orgId: string, spaceId: string): Promise<EnforcedChatSkill[]>`,
  documented: platform authority, active ∧ enforced, sorted by id, latest
  published, throws on failure (the caller refuses the turn).
- `packages/core/CHANGELOG.md` `[Unreleased]` entry; update
  `packages/core/test/export-surface.test.ts` expectations if the new exports
  are listed there.

### 3. API — the service

- New `apps/api/src/services/chat-enforced-skills.ts`:
  - `listEnforcedSkillIds(scope)`: `packages` ⟕ `spacePackages` (+ shares, via
    `placementRowJoin` / `placementShareJoin`) where `type = 'skill'`,
    `chatEnforced`, `orgOrSystemFilter`, `notEphemeralFilter`,
    `activeHereSql(spaceId)`, ordered by id. Reuse `activePackagesFilter` if it
    can be exported from `space-packages.ts` instead of restating it.
  - `loadEnforcedChatSkills(orgId, spaceId)`: ids above, then per id
    `getVersionDetail(id, "latest")` + `requirePublishedArchive("skill", …)` +
    `decodeSkillMarkdown` — the path `loadPublishedDefinition`
    (`routes/packages.ts:895`) already runs. Extract that projection into a
    service function both call rather than importing from a route file.
  - `enforcedSkillsContentLength(orgId, spaceId, tx)` for the PATCH checks.
- `apps/api/src/lib/modules/registry.ts` `buildPlatformServices`: wire
  `loadEnforcedChatSkills`.

### 4. API — the PATCH

`apps/api/src/routes/spaces.ts`:

- `updatePackageSchema`: `chat_enforced: z.boolean().optional()`.
- After `gateSpacePackageWrite(…, "configure")` (which already returns the
  type): `chat_enforced` on a non-skill → 400 `chat_enforce_not_skill`.
- `chat_enforced: true` on a row not yet enforced: one transaction, advisory
  lock `space-chat-enforced:${spaceId}` (same shape as `withPackageDraftLock`),
  then in order:
  - `latest` absent → 409 `no_published_version`;
  - enforced count ≥ `MAX_ENFORCED_CHAT_SKILLS` → 409 `enforced_skills_limit`;
  - current enforced total + this skill's latest `SKILL.md` >
    `CHAT_SKILLS_CONTENT_BUDGET_CHARS` → 409 `enforced_skills_budget`;
  - write the flag in the same transaction. `updateSpacePackage` takes an
    optional `tx`.
- `false`: plain write, no lock.
- Audit via `recordAuditFromContext`, only when the stored value changed:
  `package.chat_enforced` / `package.chat_released`, `resourceType: "package"`,
  `after: { spaceId }`.
- `spacePackageSelect` (`services/space-packages.ts:527`) projects
  `chat_enforced`; so do `listSpacePackages` and `getSpacePackage`.
- `services/package-library.ts` placement wire object (≈ l. 243) carries
  `chat_enforced`.
- OpenAPI: `SpacePackage` (`openapi/schemas.ts:340`), the PATCH body
  (`openapi/paths/spaces.ts:549`), the library placement
  (`openapi/schemas.ts:2354`), the new 400/409 codes. `bun run openapi:baseline`.

### 5. Chat module — reading and the prompt

- `platform-services.ts`: `ChatPlatformDeps.loadEnforcedSkills`, captured from
  `ctx.services`.
- `chat-stream.ts`: start `deps.loadEnforcedSkills(orgId, spaceId)` in phase B,
  in parallel with the caller context, NOT inside `buildCallerContextBlock`
  (whose 400 fallback and `""` degradation would drop it). A rejection →
  problem response 503 `enforced_skills_unavailable`, raised before the user
  message is persisted and before the MCP session opens.
- `skills.ts` `resolveChatSkills(selection, contents, enforced)`:
  - enforced first, spending the budget; `content: null` or over budget →
    notice ("required by this space but not available / does not fit");
  - chosen pins minus enforced ids, then as today;
  - `MAX_PINNED_SKILLS` unchanged, enforced do not count.
- `prompt.ts`:
  - Extract the `## Skills` rendering out of `formatCallerContext` into
    `formatSkillsSection(...)`, appended by the caller whether or not the
    context block rendered — the only way the enforced skills survive the
    identity-only fallback and the `""` degradation.
  - New `SKILLS_ENFORCED_LEAD`: required by this space in every conversation;
    win over chosen skills on conflict; only `SKILL.md` is provided, sibling
    files are not reachable unless `getSkill` is on the turn.
  - Section rendered when there are enforced skills, whatever `readsSkills`.
  - `auto` catalogue: drop enforced ids.
  - `SKILLS_STRICT_NOTE`: name the enforced skills as part of the limit; the
    user lifts only their own restriction, not the space's.
  - Byte stability: enforced sorted by id, same `skillBlock` format
    (`<skill id version>`).
- New read route in `routes.ts`: `GET /api/chat/enforced-skills` (space from
  the router's entry, gated `chat:write`), answering
  `{ data: [{ id, name, version }] }` — names only, from the same service
  (`content` stripped). OpenAPI in `module-chat/src/openapi.ts`.

`turnPermissions` does not change: `strict` still strips `skills:*`.

### 6. UI

- `apps/web/src/components/package-library.tsx`: on a skill row placed in the
  space, a switch "Imposer dans le chat" next to the activation checkbox
  (≈ l. 456). Enabled when published and the caller holds `skills:write` in
  the space; turning it on opens a confirmation stating the disclosure
  ("le contenu du skill sera visible par tous les membres qui discutent dans
  cet espace, quels que soient leurs droits sur les skills"). 409 codes mapped
  to French messages. i18n keys flat (`web-i18n` convention).
- `packages/module-chat/src/ui/skills-picker.tsx`: query
  `["chat","enforced-skills",spaceId]`; enforced rows first, checked,
  disabled, badge "Imposé par l'espace"; excluded from the choosable rows and
  from the pin cap.
- When the picker is not mounted (`canPinSkills` false), a read-only indicator
  in the composer lists the enforced names. Mounted on `chat:write` alone.

### 7. Tests

- Unit (`module-chat/test`): `resolveChatSkills` — enforced first, budget
  shared, pin/enforced dedupe, `content: null` notice; prompt — section present
  without `readsSkills`, `auto` does not list enforced, strict note, byte
  stability across two renders, section survives the identity-only fallback.
- Integration (`apps/api/test`, label `integration`):
  - PATCH: 403 without `skills:write`, 404 unplaced, 400 non-skill, 409 draft
    only, 409 cap, 409 budget, concurrent enforcements (two parallel PATCH at
    cap − 1 → one 409), audit written once on change and not on a repeat.
  - Service: draft edited after publish → published content served; skill
    deactivated → absent; re-activated → present; published versions deleted
    → `content: null`.
  - Chat turn: member with `chat:write` only → enforced `SKILL.md` in the
    system prompt; `strict` token without `skills:*`; service throws → 503 and
    no message persisted.
- e2e (`e2e/tests/chat/skills.ui.spec.ts`): library toggle with confirmation;
  picker shows the locked row.

### 8. Docs

- `docs/plans/chat-skills.md`: a "Space-enforced skills" section in the model
  table (the enforced column spans all three modes).
- This file rewritten to describe the delivered state before merge.

## Risks

- **Cache**: every enforce/release/publish costs each active session in the
  space one miss — accepted, stated in the issue.
- **TTFT**: one more read in phase B, in parallel; one indexed query plus one
  archive read per enforced skill (≤ 3). Measure against the phase-B timing
  already logged.
- **Core surface**: the new `PlatformServices` member is a contract change for
  out-of-tree module hosts that build `PlatformServices` themselves (none
  known); CHANGELOG under `[Unreleased]`, shipped with the next core release.
