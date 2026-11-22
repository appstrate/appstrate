# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165); the
server-owned pins (sources, statuses, deltas, assistant loads) are #2356.

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has two skill settings, stored on `chat_sessions`: `pinned_skills` (the pinned
skills, whoever pinned them) and `skill_discovery` (default `true`).

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
most 5, no FK), `assistant_skills text[]` (the part of the pins the assistant made) and
`skill_status jsonb` (`{ [packageId]: "injected" | "over_budget" | "unavailable" | "unreadable" }`).
Migration 0112 enforces by CHECK constraint `assistant_skills ⊆ pinned_skills` and at most 5 pins;
the application keeps `keys(skill_status) ⊆ pinned_skills`.

Every session DTO carries `skill_discovery` and `skills: [{ id, source: "user" | "assistant",
status }]`, sorted by id; `status` is null for a pin no claimed turn has evaluated.

### Statuses

Each pin gets a verdict: `injected`; `over_budget`; `unavailable` (in no `skills/list` of the
turn's spaces, both answered); `unreadable` (a read failed or answered malformed, a digest other
than the listed one included). The turn that claims the conversation writes the verdicts in the
claim's own UPDATE, so a turn refused before the claim writes none; a turn that fails after its
claim has written them already.

## Writes

**Skill changes are written only by the turn's claim**, a compare-and-set on what the turn read
(origin space, limit, `skill_discovery`, the pins its prompt was built from). The request's
`pin_skills`, `unpin_skills` and `skill_discovery` are applied in that same UPDATE, each column
computed from the row as the statement finds it: pins = (stored − unpin) ∪ pin, a pin leaves
`assistant_skills`, an unpin leaves all three columns. A client that read the session before the
assistant pinned therefore cannot drop that pin, and re-applying the same changes changes nothing.

So a turn refused before the claim (400, 402, 403, 404, 409, 429, 5xx) writes nothing, its skill
changes included. Statuses:

- 409 `chat_skill_pin_limit`: the changes would leave more than 5 pins, including when another
  client's change left no room before the claim. Nothing written.
- 409 `chat_turn_scope_changed`: another client changed the pins, discovery, limit or origin
  between the turn's read and its claim. Nothing written; the resend reads the new state.
- 409 `chat_turn_in_flight`: a live turn holds the conversation; answered first, whatever else
  moved. Nothing written.

An ephemeral turn applies the changes to the default selection. The claim emits no signal itself;
the turn's user-message write signals the row, which tells the other clients.

## Assistant loads pin

A persisted turn's `read_resource` (and the platform `read` tool) that answers the `SKILL.md` the
conversation injects for a skill goes through the turn's `SkillLoad`:

- another URI (a file of the skill, another space's copy, a draft when the published version is
  injected, or the reverse) is a plain read;
- a skill already pinned is not pinned again: no re-pin, no budget. An injected one replays as a
  receipt; one the turn left out (over budget, unavailable, unreadable) is a plain read;
- else the load pins it, as `source: assistant`, when the cap (5) and the shared 64 000-character
  budget allow and the turn still holds the conversation. The budget share is reserved before the
  pin and released if it fails, so parallel tool calls never spend it twice.

If the pin cannot be made (cap, budget, the turn stopped or taken over), the read is not refused:
the model gets the text for this turn plus a note that it was not pinned, and nothing is written.

When the database confirms the pin, the history keeps the receipt
`{"uri","skill":"@scope/name","pinned":true}` in place of the `SKILL.md` text: a replay never
re-injects the body, and later turns inject it from the system prompt, where summarization cannot
drop it. An unpinned read keeps its text. An ephemeral turn has no `SkillLoad`: its loads are
plain reads.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the session row needs
none); a third setting for a listing tool distinct from discovery (`listSkills` and `resources/read`
on a skill the turn did not inject both answer to `skills:read`, so discovery is one switch);
`GET /api/me/context?skills=<ids>` (a new surface whose only answer was "active or not", which the
listing gives); a `PUT /api/chat/sessions/{id}/skills` per click (it had to create the row for a
fresh conversation, make the send wait for it, and handle a write failing before the chat exists).

## Wire contract

`POST /api/orgs/{orgId}/chat` takes `skill_discovery`, `pin_skills` and `unpin_skills` (each
optional, at most 5 ids): changes, never a full set. Absent, the stored selection stands (discovery
on, no pin, for a new conversation). Nothing is written before the first message: choosing creates
no conversation, no sidebar row, no navigation. A change on an existing conversation not followed by
a message is lost on reload, as a model choice is.

## UI

The skills panel and the `/` menu both read `GET /api/orgs/{orgId}/chat/commands` (with
`package_authoring`), so neither offers a definition the turn would not inject. The panel has one
checkbox per skill, active except a skill cited in the draft (checked, locked: `aria-disabled`, still
focusable so its reason is read out), and the discovery switch. It is mounted when `canPinSkills`
holds (`chat:write` ∧ `skills:read`) and the session read succeeded. Any pin, the assistant's
included, can be unchecked. Each row shows the pin's real state and source (pinned by the user, by
the assistant, cited in the draft, or not loaded with its reason).

The client state is the session DTO plus the user's local changes, which ride with the next message
as deltas:

- a 2xx applies them;
- a refusal keeps them for the next message;
- a request with no answer drops them: the client cannot know whether the server applied them, and
  re-sending could remove a pin the assistant added since, so they are never re-sent and the session
  detail shows the truth.

After each turn the client writes what the server accepted into the cached session detail and
re-reads it (write, then invalidate). A turn with no answer drops its changes and re-reads. The
host's realtime session updates cover the other clients.

The assistant's load renders as a chip in the thread. It shows as loaded only when the tool result
carries `skillPinned` (live and replayed); otherwise it reads "read for this message only".

## Commands

The composer's `/` menu (#2173) lists the skills the conversation can pin and the agents the caller
can launch, read as an MCP client reads the platform server (`skills/list`, `prompts/list`) over one
connection of the caller's own: `GET /api/orgs/{orgId}/chat/commands` (`?spaceId=` reads one space,
as a limited conversation). `/<skill>` is only the composer adding the id to the turn's
`pin_skills`: no backend path of its own, no one-turn injection. The skills half takes
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
