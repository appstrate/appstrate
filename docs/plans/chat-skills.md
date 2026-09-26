# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165).

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has a skill mode (`chat_sessions.skill_mode`) and a set of
chosen skills (`chat_sessions.pinned_skills`):

| Mode             | The model sees                          | Skill tools on the turn                           |
| ---------------- | --------------------------------------- | ------------------------------------------------- |
| `auto` (default) | the space's skills, one line each       | `read_skill`, `listSkills`                        |
| `manual`         | the chosen skills in full, no listing   | `read_skill`, `listSkills`, on the user's request |
| `strict`         | the chosen skills in full, nothing else | `read_skill` on the space's required skills only  |

**auto** is progressive disclosure, as in the Agent Skills spec: one line per
skill (id, version, label, description) under `## Skills`; the model loads a
body on demand with the platform MCP tool `read_skill` (`{ id, path? }`: the
`SKILL.md` and its file list, or one file at the same version). The tool is
declared on every MCP connection, so loading needs no dispatch: `readsSkills`
(`capabilities.ts`) is `transport` (`mcp:read`) ∧ `skills:read` — the grant
under which `/api/me/context` lists the skills and `read_skill` serves them. A
turn without it is shown no listing and taught no skill rule, as a turn that
cannot launch is shown no runnable agent. `listSkills`, for a truncated list,
goes through `invoke_operation` and is named only when the turn also invokes.

**manual** and **strict** inject each chosen skill's whole `SKILL.md`, front
matter included, as `<skill id="…" version="…">…</skill>` under `## Skills`,
sorted by id, after a lead line telling the model to follow them. The chat reads
them with the CALLER's own headers, so they need the caller's `skills:read`, not
the turn's. In parallel:

- `GET /api/packages/skills`, the space's ACTIVE skills, uncapped — the listing
  the picker chooses from. `getSkill` only checks readability, so a skill
  switched off here would otherwise still be injected.
- `GET /api/packages/skills/{scope}/{name}` (`getSkill`) per chosen skill gives
  the content — by construction the definition any other reader gets (the
  draft when writable, else the latest published version).

The injected `SKILL.md`s share one budget, `CHAT_SKILLS_CONTENT_BUDGET_CHARS`
(64 000, `@appstrate/core/chat-contract`), spent in stored order: what weighs on the context is the sum, so one
long skill passes while the whole fits. A chosen skill that is not active, whose
read fails, or that does not fit what is left renders one notice line instead.
At most `MAX_PINNED_SKILLS` (5) chosen skills: every one is in every turn.

**strict** also withholds every `skills:*` from the turn's permissions
(`turnPermissions`, the mechanism the agent-authoring switch uses), so the MCP
surface derived from the route guards drops `listSkills` and `getSkill`,
`read_skill` refuses every skill but those the space requires (so a chosen
skill's other files are out of reach, and the strict note says so), declaring a skill in an agent (`dependencies.skills`, checked by
`assertPackageDependenciesAccessible`) is refused, and so is writing one — a
write answers with the package detail, `SKILL.md` included, so `skills:write`
alone would read any skill the caller authors. The persona already teaches
those only on `readsSkills`. No per-operation exception is needed.

The `## Skills` section of a strict turn always says why it holds no
`skills:*`: without it, a model reads the gap as a role to fix, hunts through
other operations, and offers to change a role to reach a skill.

The mode lives on the session row, so the handler computes the turn's
permissions after its session upsert; the context block chains on the same
promise.

The system prompt is ONE `cache_control` block: what renders there is
byte-identical across turns for the same session state (the chosen skills are
stored sorted, no clocks, no counters). Changing the mode or the chosen skills, or editing a chosen skill,
may miss the cache once.

## Space-enforced skills

A space can impose skills on every conversation held in it (#1586,
`docs/plans/chat-enforced-skills.md`). They sit above the three modes: injected
in full in `auto`, `manual` and `strict` alike, before the chosen skills and out
of the shared budget first, read with the platform's authority rather than the
caller's, so no `skills:*` grant is needed. `strict` is unchanged: its turn
still holds no `skills:*`, and its note names the space's skills as part of the
restriction the user cannot lift.

## Per-conversation choice

Migration `0074` adds the `chat_skill_mode` enum and two columns to
`chat_sessions`:

- `skill_mode chat_skill_mode NOT NULL DEFAULT 'auto'`;
- `pinned_skills text[] NOT NULL DEFAULT '{}'` — sorted, deduplicated, at most
  5, no FK. Kept but unused in `auto`, so switching back restores the choice.

`ChatSkillSelection` carries the column names (`skillMode`, `pinnedSkills`), so
a session row is a selection.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the
session row needs none); two booleans ("list the space" / "allow listing"),
whose fourth combination — listing on, listing tool off — cannot be enforced:
`read_skill` and `listSkills` share `skills:read`.

The selection rides the turn: `POST /api/chat` takes `skill_mode` and
`pinned_skills` (both or neither), and `ensureSession` writes them in the
upsert that creates or claims the row, before the turn's grants are derived
from them. Absent, the stored selection stands (`auto` for a new
conversation). Nothing is written before the first message: choosing creates
no conversation, no sidebar row, no navigation, and there is no write to wait
for or to fail. A change made on an existing conversation and not followed by a
message is lost on reload — as a model choice is. Every session DTO carries both
fields. There is no chat-specific skill listing: the picker reads
`GET /api/packages/skills`.

Rejected: `GET /api/me/context?skills=<ids>` resolving the chosen skills by
exact id — a new API surface whose only answer the chat read was "active or
not", which the listing already gives.

Rejected: a `PUT /api/chat/sessions/{id}/skills` written on every click. It had
to create the row for a fresh conversation (an empty sidebar entry, an URL
change), make the send wait for it, and handle a write that fails before the
chat exists — all for a choice the next turn carries anyway.

UI: a picker in the composer — the mode as the model picker's tabs (one look
across the composer) with the chosen mode's explanation, and one checkbox per
skill, inert in `auto`. Mounted when `canPinSkills` holds (`chat:write` ∧
`skills:read`) and the session read succeeded — a failed read would show the
defaults, and a change would send them over the stored choice. The picker is
controlled: the conversation holds the selection, seeded from the session
detail, and sends only what the user changed.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted`
  visibility that would keep them out of the catalogues. Taken out of this PR:
  each must be gated on the capability it teaches (an authoring guide on
  `authors`, a web recipe on composing), and the `@appstrate` scope must be
  reserved at package creation first — today the JSON create route accepts
  any `@scope`, so a new system id can collide with an organization package.
- A `/skill` mention that loads a body into one message (#1309 open question
  5): `manual` covers it; propose it on its own if usage asks.
- Per-space default mode inherited by new sessions (per-space skills: see
  "Space-enforced skills" above).
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
