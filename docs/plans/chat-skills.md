# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165); the
server-owned pins and their statuses are #2356.

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has two skill settings, stored on `chat_sessions`: `pinned_skills` (the skills the user
pinned) and `skill_discovery` (default `true`).

**Invariant**: a skill shown as loaded is injected in the model's context. The server is the only
source of truth for the pins; the client never infers "loaded".

| `skill_discovery` | The model sees                                                  | Skill tools on the turn                              |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `true`            | the pinned skills in full, the other skills of the space listed | `read_resource` / `read`                             |
| `false`           | the pinned skills in full, nothing else                         | `read_resource` / `read` on the injected skills only |

**Discovery** is progressive disclosure, as in the Agent Skills spec: one line per skill (id,
version, `skill://` URI, description) under `## Skills`, uncapped, minus the pinned skills. The
model loads a body on demand with the chat's `read_resource` tool (`resources/read` on the platform
MCP server at that URI; a file of the skill is the URI with `SKILL.md` replaced by its path). A turn
without `mcp:read` ∧ `skills:read` is shown no listing and taught no skill rule.

**Pinned skills** are injected on every turn, discovery on or off: each skill's whole `SKILL.md`,
front matter included, as `<skill id uri version>` under `## Skills`, sorted by id. They are read
over a listing connection carrying the CALLER's permissions, so they need the caller's
`skills:read`, not the turn's. A skill the turn injects stays readable through `read_resource`
(its files included) at the injected definition, even with discovery off.

**One definition per skill.** A turn works on drafts when package authoring is on and the caller
holds `skills:write` (`turnUsesDrafts`, shared by the turn and the composer's commands). Then the
catalogue, the injected pins and the URIs an assistant load pins all take the caller's draft when
there is one; otherwise all take the published version. A listed URI therefore always pins the
definition later turns inject.

The injected `SKILL.md`s share one budget, `CHAT_SKILLS_CONTENT_BUDGET_CHARS` (64 000), spent in
stored order. A pin that is not active, whose read fails, or that does not fit renders one notice
line instead. At most 5 pins.

**Discovery off** withholds every `skills:*` from the turn's permissions (`turnPermissions`, the
mechanism the agent-authoring switch uses): the MCP surface drops `listSkills` and `getSkill`,
`read_resource` reads only injected skills, and declaring or writing a skill is refused. The
`## Skills` section says why it holds no `skills:*`, so the model does not hunt for a role to fix.

The system prompt is ONE `cache_control` block, byte-identical across turns for the same session
state. Changing discovery or the pins, or editing a pinned skill, may miss the cache once.

## Stored state

`chat_sessions` carries `skill_discovery boolean`, `pinned_skills text[]` (sorted, deduplicated, at
most 5 by CHECK constraint, no FK) and `skill_status jsonb`
(`{ [packageId]: { status: "injected" | "over_budget" | "unavailable" | "unreadable", chars } }`,
`chars` the `SKILL.md` length the turn read, `null` when it read none). Only the user pins: a
`SKILL.md` read by the assistant is a plain read whose text stays in the history.

Every session DTO carries `skill_discovery` and `pins: [{ id, status, chars }]`, sorted by id;
`status` and `chars` are null for a pin no claimed turn has evaluated. An entry off that shape reads
as not evaluated.

### Statuses

Each pin gets a verdict: `injected`; `over_budget`; `unavailable` (in no `skills/list` of the
turn's spaces, both answered); `unreadable` (a read failed or answered malformed, a digest other
than the listed one included). The turn that claims the conversation writes the verdicts in the
claim's own UPDATE, so a turn refused before the claim writes none; a turn that fails after its
claim has written them already.

## Writes

`PATCH /api/orgs/{orgId}/chat/sessions/{id}/skills` sets the selection: `{ pins?, skill_discovery? }`,
strict, at least one field, `pins` at most 5. `pins` replaces the whole set (deduped, sorted) and
drops the `skill_status` entries of the pins it removes. It answers the session object (200),
leaves `updatedAt` alone (a pin never reorders the sidebar) and signals the owner's other clients.
It is allowed while a turn runs and applies from the next turn: the claim no longer compares the
selection.

`POST /api/orgs/{orgId}/chat` takes `pins` and `skill_discovery` only on the turn that creates the
conversation, written by the INSERT, or on an ephemeral turn, over the default selection. An existing
conversation ignores them, as it ignores `spaceId` and `restricted`: its pins change through the PATCH.

The claim is a compare-and-set on the origin space and the limit alone:

- 409 `chat_turn_scope_changed`: the limit or origin moved between the turn's read and its claim.
  Nothing written; the resend reads the new state.
- 409 `chat_turn_in_flight`: a live turn holds the conversation; answered first. Nothing written.

The claim emits no signal itself; the turn's user-message write signals the row.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the session row needs
none); a third setting for a listing tool distinct from discovery (`listSkills` and `resources/read`
on a skill the turn did not inject both answer to `skills:read`, so discovery is one switch);
`GET /api/me/context?skills=<ids>` (a new surface whose only answer was "active or not", which the
listing gives); skill changes riding with the next message as deltas (a request with no answer left
the client unable to know what was applied); assistant loads that pin (a pin the user never chose,
sharing the cap and the budget).

## Wire contract

A fresh conversation's first `POST /chat` carries its selection (absent: discovery on, no pin), so
choosing creates no conversation, no sidebar row, no navigation. Every later change is a `PATCH`.

## UI

The skills panel and the `/` menu both read `GET /api/orgs/{orgId}/chat/commands` (with
`package_authoring`), so neither offers a definition the turn would not inject. The panel has one
checkbox per skill, active except a skill cited in the draft (checked, locked: `aria-disabled`, still
focusable so its reason is read out), and the discovery switch. It is mounted when `canPinSkills`
holds (`chat:write` ∧ `skills:read`) and the session read succeeded. Any pin can be
unchecked. Each row shows the pin's real state (cited in the draft, loaded, or not loaded with its
reason).

The client state is the session DTO. A new conversation's choices ride with its first message; on
an existing one each change is a `PATCH`, and the host's realtime session updates cover the other
clients. The assistant's `SKILL.md` read renders as a chip in the thread, as a read.

## Commands

The composer's `/` menu (#2173) lists the skills the conversation can pin and the agents the caller
can launch, read as an MCP client reads the platform server (`skills/list`, `prompts/list`) over one
connection of the caller's own: `GET /api/orgs/{orgId}/chat/commands` (`?spaceId=` reads one space,
as a limited conversation). `/<skill>` is only the composer adding the id to the
conversation's pins: no backend path of its own, no one-turn injection. The skills half takes
`package_authoring` (boolean, absent = on, as on `POST /chat`) and lists a skill's draft under
`turnUsesDrafts` alone.

An agent launch is a `data-agent-prompt` part (`{ name, title }`) in the last user message. The turn
resolves it with `prompts/get` (the typed text as `request`) before taking the slot and the claim,
and stores the returned instructions in the part's `data.text`, capped at 64 KB. The model reads
that text in place of the typed text; a later turn takes it from the stored `chat_messages` row by
message id, never from the browser's copy, and never asks the server again. Nothing parses
`/run-…` out of the text.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted` visibility that would
  keep them out of the catalogues. Each must be gated on the capability it teaches, and the
  `@appstrate` scope must be reserved at package creation first: the JSON create route accepts any
  `@scope`, so a new system id could collide with an organization package.
- Per-space default selection inherited by new sessions.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
