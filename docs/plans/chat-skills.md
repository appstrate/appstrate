# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165).

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

```
skills indexed for a turn =
    pinned on the session        (chat_sessions.pinned_skills)
  ∪ the space catalogue          (when chat_sessions.skill_catalogue)
```

Gated by `readsSkills` in `turnCapabilities` (`capabilities.ts`): `invokes` ∧
`skills:read`, since a skill is loaded through `invoke_operation`. A turn
without it is taught no skill rule, shown no skills section and sends no
`?skills=` — as a turn that cannot launch is shown no runnable agent.
`/api/me/context` answers no skill field without `skills:read` either.

Progressive disclosure, as in the Agent Skills spec: one line per skill (id,
version, label, description) in the `## Skills` section of the context block,
pins tagged `(pinned)` and sorted by id; the model loads a body on demand through
`invoke_operation` → `getSkill`, which applies the platform's single
definition-read rule (the draft when writable, else the latest published
version). No body ever enters the system prompt.

The system prompt is ONE `cache_control` block: what renders there is
byte-identical across turns for the same session state (sorted, no clocks, no
counters); changing pins or the catalogue switch may miss the cache once.

## Caller context

`GET /api/me/context?skills=<comma-separated ids>` resolves the named skills by
exact id for the caller in the current space, past the 15-row cap of `skills`:
`requested_skills`, in no particular order (the chat sorts). An id that resolves
nothing — unknown, inactive, out of reach — is simply absent; the chat, which
knows what it asked for, renders one notice line per such pin. At most
`MAX_REQUESTED_SKILLS` (30) distinct ids; a malformed id or more is a 400. One
round trip.

## Per-conversation choice

Migration `0069` adds two columns to `chat_sessions`:

- `skill_catalogue boolean NOT NULL DEFAULT true` — whether the space
  catalogue is indexed;
- `pinned_skills text[] NOT NULL DEFAULT '{}'` — sorted, deduplicated, at most
  20, no FK. A pin that no longer resolves renders one notice line, and still
  shows in the picker so it can be removed.

`ChatSkillSelection` carries the column names (`skillCatalogue`,
`pinnedSkills`), so a session row is a selection.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the
session row needs none); a three-mode enum ("pins only" removed 3 index lines).

`PUT /api/chat/sessions/{id}/skills` `{ skill_catalogue, pinned_skills }` → 204,
one upsert (`ensureSession` with the selection): it creates the row for a
client-minted id, as the first turn does — so a picker write on a fresh
conversation makes it appear in the sidebar with no messages — and it never
bumps `updatedAt`. Every session DTO carries both fields. There is no
chat-specific skill listing: the picker reads `GET /api/packages/skills`.

UI: a picker in the composer (catalogue switch + one pin checkbox per skill),
mounted when the shell's `canPinSkills` holds (`chat:write` ∧ `readsSkills`) and
the session read succeeded — a failed read would let the first click write the
defaults over the stored pins. The selection lives in local state seeded from
the session detail; one write at a time (the controls are disabled while it is
in flight, so writes never race), reverted on failure.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted`
  visibility that would keep them out of the catalogues. Taken out of this PR:
  each must be gated on the capability it teaches (an authoring guide on
  `authors`, a web recipe on composing), and the `@appstrate` scope must be
  reserved at package creation first — today the JSON create route accepts
  any `@scope`, so a new system id can collide with an organization package.
- A `/skill` mention that loads a body into one message (#1309 open question
  5): a pin plus `getSkill` covers it; propose it on its own if usage asks.
- Per-space default skills inherited by new sessions.
- A dedicated `load_skill` MCP tool — measure `getSkill` first.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
