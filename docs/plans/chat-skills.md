# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165).

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has a skill mode (`chat_sessions.skill_mode`) and a set of
chosen skills (`chat_sessions.pinned_skills`):

| Mode             | The model sees                          | Skill tools on the turn                         |
| ---------------- | --------------------------------------- | ----------------------------------------------- |
| `auto` (default) | the space's skills, one line each       | `listSkills`, `getSkill`                        |
| `manual`         | the chosen skills in full, no listing   | `listSkills`, `getSkill`, on the user's request |
| `strict`         | the chosen skills in full, nothing else | none                                            |

**auto** is progressive disclosure, as in the Agent Skills spec: one line per
skill (id, version, label, description) under `## Skills`; the model loads a
body on demand through `invoke_operation` → `getSkill`. It needs `readsSkills`
(`capabilities.ts`: `invokes` ∧ `skills:read`); a turn without it is shown no
listing and taught no skill rule, as a turn that cannot launch is shown no
runnable agent.

**manual** and **strict** inject each chosen skill's whole `SKILL.md`, front
matter included, as `<skill id="…" version="…">…</skill>` under `## Skills`,
sorted by id, after a lead line telling the model to follow them. The chat reads
them with the CALLER's own headers, so they need the caller's `skills:read`, not
the turn's. Two reads, in parallel with nothing between them:

- `GET /api/me/context?skills=<ids>` answers which chosen skills are ACTIVE in
  the space (`requested_skills`, the listing's activation rule, past its 15-row
  cap). `getSkill` only checks readability, so a skill switched off here would
  otherwise still be injected.
- `GET /api/packages/skills/{scope}/{name}` (`getSkill`) per chosen skill gives
  the content — by construction the definition any other reader gets (the
  draft when writable, else the latest published version).

A chosen skill that is not active, whose read fails, or whose `SKILL.md` is
longer than `MAX_SKILL_CONTENT_CHARS` (16 000) renders one notice line instead.
At most `MAX_PINNED_SKILLS` (5) chosen skills: every one is in every turn.

**strict** also withholds `skills:read` from the turn's permissions
(`turnPermissions`, the mechanism the agent-authoring switch uses), so the MCP
surface derived from the route guards drops `listSkills` and `getSkill`, and
declaring a skill in an agent (`dependencies.skills`, checked by
`assertPackageDependenciesAccessible`) is refused. The persona already teaches
those only on `readsSkills`. No per-operation exception is needed.

The mode lives on the session row, so the handler computes the turn's
permissions after its session upsert; the context block chains on the same
promise.

The system prompt is ONE `cache_control` block: what renders there is
byte-identical across turns for the same session state (sorted, no clocks, no
counters). Changing the mode or the chosen skills, or editing a chosen skill,
may miss the cache once.

## Caller context

`GET /api/me/context?skills=<comma-separated ids>` resolves the named skills by
exact id for the caller in the current space: `requested_skills`, in no
particular order (the chat sorts). An id that resolves nothing — unknown,
inactive, out of reach — is simply absent. At most `MAX_REQUESTED_SKILLS` (30)
distinct ids; a malformed id or more is a 400. The chat asks only in `manual`
and `strict`.

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
`getSkill` and `listSkills` share `skills:read`.

`PUT /api/chat/sessions/{id}/skills` `{ skill_mode, pinned_skills }` → 204, one
upsert (`ensureSession` with the selection): it creates the row for a
client-minted id, as the first turn does — so a picker write on a fresh
conversation makes it appear in the sidebar with no messages, and the URL
adopts its id on that first write, as on a first send — and it never bumps
`updatedAt`. Every session DTO carries both fields. There is no chat-specific
skill listing: the picker reads `GET /api/packages/skills`.

UI: a picker in the composer — the mode as the model picker's tabs (one look
across the composer) with the chosen mode's explanation, and one checkbox per skill, inert in `auto`. Mounted when `canPinSkills` holds
(`chat:write` ∧ `skills:read`) and the session read succeeded — a failed read
would let the first click write the defaults over the stored choice. The
selection lives in local state seeded from the session detail; one write at a
time (the controls are disabled while it is in flight, so writes never race),
reverted on failure. A send waits for a selection write in flight, since the
turn reads the selection off the row.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted`
  visibility that would keep them out of the catalogues. Taken out of this PR:
  each must be gated on the capability it teaches (an authoring guide on
  `authors`, a web recipe on composing), and the `@appstrate` scope must be
  reserved at package creation first — today the JSON create route accepts
  any `@scope`, so a new system id can collide with an organization package.
- Multi-file skills (#1312): an injected `SKILL.md` that points at other files
  leaves them out, and `strict` has no tool to read them.
- A `/skill` mention that loads a body into one message (#1309 open question
  5): `manual` covers it; propose it on its own if usage asks.
- Per-space default skills or mode inherited by new sessions.
- A dedicated `load_skill` MCP tool — measure `getSkill` first.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
