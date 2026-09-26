# Space-enforced skills in the chat

Implements issue #1586. Builds on #1494 (`docs/plans/chat-skills.md`).

A space imposes skills on every chat conversation held in it: each is injected
in full on every turn, whatever the skill mode and the member's `skills:*`
grants, and cannot be removed from the composer. Enforcement is a property of
the placement row, so the activation rule stays the only rule.

## Storage

`space_packages.chat_enforced boolean NOT NULL DEFAULT false` (migration
`0075`). It is meaningful for skills only. Like every placement setting, it
survives deactivation: a switched-off skill keeps its flag, is not injected, and
comes back enforced when switched on again. It shows up on the wire as
`SpacePackage.chat_enforced` and on the library placement.

## Enforcing: `PATCH /api/spaces/{spaceId}/packages/{scope}/{name}`

`chat_enforced: boolean` in the body.

- **Gate:** the route's single `configure` gate, which for a skill is
  `skills:write` in the space. It runs before the body is parsed.
- **Refusals:**

  | Status | Code                           | When                                                                                               |
  | ------ | ------------------------------ | -------------------------------------------------------------------------------------------------- |
  | 400    | `chat_enforced_not_skill`      | the package is not a skill                                                                         |
  | 404    | `not_found`                    | the package is not placed in the space                                                             |
  | 409    | `no_published_version`         | the skill has no `latest` published version                                                        |
  | 409    | `enforced_skills_limit`        | more than `MAX_ENFORCED_CHAT_SKILLS` (3) flagged rows in the space, deactivated ones included      |
  | 409    | `enforced_skills_budget`       | the flagged skills' published `SKILL.md` bodies exceed `CHAT_SKILLS_CONTENT_BUDGET_CHARS` (64 000) |
  | 422    | `version_artifact_unavailable` | the published archive of this skill, or of another skill already flagged here, cannot be read      |

- **Setting `true`:** `updatePlacementSettings` runs it in one transaction
  under the advisory lock `space-chat-enforced:<spaceId>`. The flag is written
  first, then checked (`assertChatEnforceable`); a refusal rolls the whole patch
  back, and two concurrent enforcements cannot both pass the cap.
- **Setting `false`:** a plain write, with no lock and no check.
- **Audit:** `package.chat_enforced` / `package.chat_released`
  (`resourceType: "package"`, `after: { spaceId }`), written only when the
  stored value actually changed.

Both constants live in `@appstrate/core/chat-contract`, so the PATCH and the
chat agree on them.

## Reading: `loadEnforcedChatSkills` and `listEnforcedChatSkills`

Both `ctx.services` entries are implemented in
`apps/api/src/services/chat-enforced-skills.ts` and run with platform
authority. `listEnforcedChatSkills` answers `EnforcedChatSkillRef
{ packageId, name, version }` from the database alone, for the names route;
`loadEnforcedChatSkills`, for the turn, also reads each archive:

- It returns the space's **active** skills whose placement is flagged, ordered
  by id.
- Each comes as `EnforcedChatSkill { packageId, name, version, content }` at its
  `latest` published version, never the draft.
- `content: null` means only that no published version resolves (none
  published, or deleted). The turn then renders a notice ("required by this
  space but has no published version to follow") instead of the skill.
- Any other failure rejects, an unreadable archive
  (`version_artifact_unavailable`, a storage fault) included. The chat module's
  deps wrapper (`buildChatPlatformDeps`) turns a rejection of either read into a
  **503 `enforced_skills_unavailable`**. When the cause is an API error (a lost
  archive), its detail, which names the skill, is appended, so an admin knows
  which skill to release; otherwise the detail says to retry.

## The turn

`handleChatStream` starts the read at the beginning of phase B, in parallel with
the session upsert, keyed on the space the router entered, and awaits it in
phase A's join (with the model list and the session row). A 503 therefore
refuses the turn before attachment materialization, credential resolution, the
admission gate, the user message, the active-stream marker and the MCP session.
As with every preamble refusal, the session row and the turn's skill selection
are already upserted by then. The same promise feeds the caller-context block.

`## Skills` is rendered by `formatSkillsSection`, which the context block
appends on every path. The enforced skills survive both degradations of
`/api/me/context`: the identity-only block on a 400, and the section alone on
any other failure. The section appears whenever the space enforces skills,
whatever `readsSkills`. Its order:

1. the strict note, if the mode is `strict`;
2. the enforced lead line and one `<skill id version>` block per enforced skill,
   in id order;
3. the `auto` listing, minus the injected enforced ids, only when `readsSkills`;
4. the chosen lead line and blocks;
5. the notices.

- **Budget and dedupe:** enforced skills spend the shared budget first. A pin
  naming an enforced skill that was injected is dropped without a notice; one
  whose enforced copy was left out (no published version, over budget) stands as
  an ordinary pin. Enforced skills do not count toward `MAX_PINNED_SKILLS`.
- **Lead line:** the enforced skills win over a chosen skill on conflict, and
  only `SKILL.md` is injected: a file it references is read with `read_skill`
  (below).
- **Strict mode:** the note says the conversation is limited to the space's
  skills plus the user's, that the user lifts only their own restriction, and
  that a chosen skill comes as its `SKILL.md` alone. `turnPermissions` is
  unchanged: `strict` still strips every `skills:*`.
- **Cache:** nothing in the section varies per turn. The prompt stays
  byte-identical for a given session state. Enforcing, releasing or publishing a
  new version costs each active session in the space one cache miss.

## A skill's other files: `read_skill`

A multi-file skill (#1312) injects only its `SKILL.md`; the files it references
are read on demand through the platform MCP tool `read_skill`
(`{ id, path? }`: without `path`, the `SKILL.md`, the file list and the version
served; with it, that file at the same version). The tool is read-only and
declared on every MCP connection, so the chat engine holds it on every turn.
It answers in three branches, in this order:

1. the skill is enforced and active in the request's space and the caller
   holds `chat:write` there (a chat turn always does): its latest published
   version, resolved on each call, with platform authority and no `skills:*`
   needed — a writer never reads a draft that disagrees with the injected
   `SKILL.md`;
2. otherwise, the caller holds `skills:read`: the version `getSkill` serves
   them (the draft when they may write it, else the latest published), with
   `getSkill`'s order of refusals — 403 before 404;
3. otherwise: refused.

The first branch is why the rule lives in the tool rather than in RBAC. An
enforced skill is exactly the one a member without `skills:read` must follow,
and the space already disclosed its `SKILL.md` to them; its files are the same
disclosure, bounded by the same flag. Widening the REST routes instead would
make every `skills:*` guard depend on chat policy. So the REST RBAC is
untouched: `invoke_operation` on the skill routes still needs `skills:read`,
and `strict` still strips every `skills:*` from the turn token — a strict turn
reads the space's skills' files through branch 1 and no chosen skill's.

The persona teaches loading on `readsSkills` (`transport` ∧ `skills:read`,
`transport` being `mcp:read`). The enforced lead line names `read_skill` on
`transport` alone, since branch 1 needs no `skills:*`; a turn without the
transport holds no tool, and its lead says only that `SKILL.md` is provided.
Both variants are static per capability set, so the section stays byte-stable
per session.

## `GET /api/chat/enforced-skills`

Answers the names for the space the router entered:
`{ object: "list", data: [{ id, name, version }] }`, read from the database
through `listEnforcedChatSkills` (no archive download). It never returns
content, because a member without `skills:read` may call it.

It is gated `chat:write`, like the turn, and rate-limited at 120/min. A load
failure answers the same 503.

## UI

- **Library** (`apps/web/src/components/package-library.tsx`): on a skill row of
  the space, an "Imposé dans le chat" checkbox.
  - Turning it on needs `skills:write` in the space (no personal-space
    exemption) and a published version: the library package row carries
    `published`, and the box is disabled with a hint ("Publiez une version du
    skill d'abord") when it is false. A switched-off skill can be enforced; the
    flag waits for re-activation. Turning it off needs `skills:write` only.
  - Turning it on opens a confirmation that discloses the effect: the published
    `SKILL.md` becomes visible to every member who chats in the space. Turning
    it off asks for nothing.
  - A version deleted between the read and the click still gets the server's
    409 `no_published_version`. Each 409 has a French message.
- **Picker** (`packages/module-chat/src/ui/skills-picker.tsx`): it reads
  `["chat","enforced-skills",spaceId]`.
  - Enforced rows come first, checked and disabled, with the badge "Imposée par
    l'espace".
  - They are excluded from the choosable rows and from the pin cap.
- **Read-only indicator:** a member with `chat:write` but no picker (no
  `skills:read`) sees the enforced names in the composer
  (`EnforcedSkillsIndicator`).
