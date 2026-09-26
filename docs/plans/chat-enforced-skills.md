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
  | 422    | `version_artifact_unavailable` | the skill's own published archive cannot be read                                                   |

- **Setting `true`:** runs in one transaction under the advisory lock
  `space-chat-enforced:<spaceId>` (`withChatEnforcementLock`). The flag is
  written first, then checked (`assertChatEnforceable`); a refusal rolls the
  whole patch back, and two concurrent enforcements cannot both pass the cap.
- **Setting `false`:** a plain write, with no lock and no check.
- **Audit:** `package.chat_enforced` / `package.chat_released`
  (`resourceType: "package"`, `after: { spaceId }`), written only when the
  stored value actually changed.

Both constants live in `@appstrate/core/chat-contract`, so the PATCH and the
chat agree on them.

## Reading: `loadEnforcedChatSkills`

`ctx.services.loadEnforcedChatSkills(orgId, spaceId)` is implemented in
`apps/api/src/services/chat-enforced-skills.ts` and runs with platform authority.

- It returns the space's **active** skills whose placement is flagged, ordered
  by id.
- Each comes as `EnforcedChatSkill { packageId, name, version, content }` at its
  `latest` published version, never the draft.
- A skill with nothing published, or whose archive is unreadable, comes back
  with `content: null`. The turn then renders a notice ("required by this space
  but not available here") instead of the skill.
- Any other failure rejects. The chat module's deps wrapper
  (`buildChatPlatformDeps`) turns that rejection into a
  **503 `enforced_skills_unavailable`**.

## The turn

`handleChatStream` starts the read at the beginning of phase B, in parallel with
the session upsert, keyed on the space the router entered. The result is joined
with the caller-context block. A 503 refuses the turn after the admission gate,
but before the model binding, capacity, the user message, the active-stream
marker and the MCP session.

`## Skills` is rendered by `formatSkillsSection`, which the context block
appends on every path. The enforced skills survive both degradations of
`/api/me/context`: the identity-only block on a 400, and the section alone on
any other failure. The section appears whenever the space enforces skills,
whatever `readsSkills`. Its order:

1. the strict note, if the mode is `strict`;
2. the enforced lead line and one `<skill id version>` block per enforced skill,
   in id order;
3. the `auto` listing, minus the enforced ids, only when `readsSkills`;
4. the chosen lead line and blocks;
5. the notices.

- **Budget and dedupe:** enforced skills spend the shared budget first. A pin
  naming an enforced skill is dropped without a notice. Enforced skills do not
  count toward `MAX_PINNED_SKILLS`.
- **Lead line:** the enforced skills win over a chosen skill on conflict, and
  only `SKILL.md` is provided.
- **Strict mode:** the note says the conversation is limited to the space's
  skills plus the user's, and that the user lifts only their own restriction.
  `turnPermissions` is unchanged: `strict` still strips every `skills:*`.
- **Cache:** nothing in the section varies per turn. The prompt stays
  byte-identical for a given session state. Enforcing, releasing or publishing a
  new version costs each active session in the space one cache miss.

## `GET /api/chat/enforced-skills`

Answers the names for the space the router entered:
`{ object: "list", data: [{ id, name, version }] }`. It never returns content,
because a member without `skills:read` may call it.

It is gated `chat:write`, like the turn, and rate-limited at 120/min. A load
failure answers the same 503.

## UI

- **Library** (`apps/web/src/components/package-library.tsx`): on a skill row of
  the space, an "Imposé dans le chat" checkbox.
  - Turning it on needs `skills:write` in the space (no personal-space
    exemption), the skill active there, and a published version: the library
    package row carries `published`, and the box is disabled with a hint
    ("Publiez une version du skill d'abord") when it is false. Turning it off
    needs `skills:write` only, so a flag kept on a switched-off or unpublished
    skill can still be released.
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
