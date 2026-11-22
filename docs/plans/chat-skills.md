# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165).

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has two skill settings, stored on `chat_sessions`:
`pinned_skills` (the chosen skills) and `skill_discovery` (default `true`).

| `skill_discovery` | The model sees                                                  | Skill tools on the turn                     |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `true`            | the pinned skills in full, the other skills of the space listed | `read_resource`                             |
| `false`           | the pinned skills in full, nothing else                         | `read_resource` on the injected skills only |

**Discovery** is progressive disclosure, as in the Agent Skills spec: one line per
skill (id, version, `skill://` URI, description) under `## Skills`, the
entries of `skills/list` (the draft's entry first when the turn itself may
read it: it keeps the caller's `skills:write`, which the authoring switch
drops; otherwise the published entry, so every URI listed is one the turn's
`read_resource` reads), uncapped, minus the pinned skills (those are injected);
the model loads a body on demand with the chat's `read_resource`
tool, `resources/read` on the platform MCP server at that URI (a file of the
skill: the URI with `SKILL.md` replaced by the file's path). `resources/read`
is served on every MCP connection, so loading needs no dispatch: `readsSkills`
(`capabilities.ts`) is `transport` (`mcp:read`) ∧ `skills:read` — the grant
under which `skills/list` lists the skills and `resources/read` serves them. A
turn without it is shown no listing and taught no skill rule, as a turn that
cannot launch is shown no runnable agent.

**Pinned skills** are injected on every turn, discovery on or off: each chosen skill's whole `SKILL.md`, front
matter included, as `<skill id="…" uri="skill://…" version="…">…</skill>` (a draft: `definition="draft"`) under `## Skills`,
sorted by id, after a lead line telling the model to follow them. The chat reads
them over a listing MCP connection whose bearer carries the CALLER's own
permissions and no injected-skills claim, closed before the turn's connection
opens, so they need the caller's `skills:read`, not the turn's. The catalogue and
the pinned skills come from the same two `skills/list` calls. Whatever skill a
turn injects stays readable through `read_resource` (its files included) at the
injected definition — injected in this turn (signed claim) ⇒ readable at that
definition; else `skills:read`; else refused. On that connection:

- `skills/list`, the space's ACTIVE skills at their published definition, and
  `skills/list` with `_meta` `dev.appstrate/definition: "draft"`, the drafts
  the caller may read. A chosen skill takes its draft entry when there is one,
  else its published entry; a skill in neither list gets a notice.
- `resources/read` of each chosen skill's `SKILL.md` gives the content, the
  bytes every MCP client and `appstrate code sync` get at that URI.

The injected `SKILL.md`s share one budget, `CHAT_SKILLS_CONTENT_BUDGET_CHARS`
(64 000, `packages/module-chat/src/skills.ts`), spent in stored order: what
weighs on the context is the sum, so one long skill passes while the whole fits. A chosen skill that is not active, whose
read fails, or that does not fit what is left renders one notice line instead.
At most `MAX_PINNED_SKILLS` (5) chosen skills: every one is in every turn.

**Discovery off** withholds every `skills:*` from the turn's permissions
(`turnPermissions`, the mechanism the agent-authoring switch uses), so the MCP
surface derived from the route guards drops `listSkills` and `getSkill`,
`read_resource` reads only the skills injected in the turn (named in the turn's
signed MCP bearer), declaring a skill in an agent (`dependencies.skills`, checked by
`assertPackageDependenciesAccessible`) is refused, and so is writing one — a
write answers with the package detail, `SKILL.md` included, so `skills:write`
alone would read any skill the caller authors. The persona already teaches
those only on `readsSkills`. No per-operation exception is needed.

The `## Skills` section of a turn without discovery always says why it holds no
`skills:*`: without it, a model reads the gap as a role to fix, hunts through
other operations, and offers to change a role to reach a skill.

The selection lives on the session row, so the handler computes the turn's
permissions after its session upsert; the context block chains on the same
promise.

The system prompt is ONE `cache_control` block: what renders there is
byte-identical across turns for the same session state (the chosen skills are
stored sorted, no clocks, no counters). Changing discovery or the chosen skills, or editing a chosen skill,
may miss the cache once.

## Per-conversation choice

`chat_sessions` carries the selection:

- `skill_discovery boolean NOT NULL DEFAULT true`;
- `pinned_skills text[] NOT NULL DEFAULT '{}'` — sorted, deduplicated, at most
  5, no FK.

`ChatSkillSelection` carries the column names (`skillDiscovery`, `pinnedSkills`), so
a session row is a selection.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the
session row needs none); a third setting for a listing tool distinct from
discovery: `listSkills` and `resources/read` on a skill the turn did not inject both answer to
`skills:read` alone, so discovery is one switch.

The selection rides the turn: `POST /api/chat` takes `skill_discovery` and
`pinned_skills` (both or neither), and `ensureSession` writes them in the
upsert that creates or claims the row, before the turn's grants are derived
from them. Absent, the stored selection stands (discovery on, no chosen skill, for a new
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

UI: a skills panel in the composer — one checkbox per skill, always active,
and the discovery switch. Mounted when `canPinSkills` holds (`chat:write` ∧
`skills:read`) and the session read succeeded — a failed read would show the
defaults, and a change would send them over the stored choice. The panel is
controlled: the conversation holds the selection, seeded from the session
detail, and sends only what the user changed.

## Commands

The composer's `/` menu (#2173) lists the skills the conversation can pin and the agents the
caller can launch, read as an MCP client reads the platform server (`skills/list`,
`prompts/list`) over one connection of the caller's own: `GET /api/orgs/{orgId}/chat/commands`
(`?spaceId=` reads one space, as a limited conversation). `/<skill>` is only the composer
adding the id to `pinned_skills`: no backend path of its own, no one-turn injection.

An agent launch is a `data-agent-prompt` part (`{ name, title }`) in the last user message. The
turn resolves it with `prompts/get` (the typed text as `request`) before taking the slot and the
claim, and stores the returned instructions in the part's `data.text`, capped at 64 KB. The model
reads that text in place of the typed text; a later turn takes it from the stored
`chat_messages` row by message id, never from the browser's copy, and never asks the server
again. Nothing parses `/run-…` out of the text.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted`
  visibility that would keep them out of the catalogues. Taken out of this PR:
  each must be gated on the capability it teaches (an authoring guide on
  `authors`, a web recipe on composing), and the `@appstrate` scope must be
  reserved at package creation first — today the JSON create route accepts
  any `@scope`, so a new system id can collide with an organization package.
- Per-space default selection inherited by new sessions.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
