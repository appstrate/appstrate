# Skills in the chat

Status: **implemented** (#2357).

Implements issue #1309 (replaces #851, #1126 and #1165); the server-owned pins and their statuses
are #2356; the composer's `/` menu is #2173.

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is deliberately resource-free
(`pi-chat/resource-loader.ts`: `noSkills`), so Pi's native skill directory is not an option.

## Model

Each conversation has two skill settings on `chat_sessions`: `pinned_skills` (the user's pins, at
most 5) and `skill_discovery` (default `true`).

**Invariant**: a skill shown as loaded is injected in the model's context. The server is the only
source of truth for the pins; the client never infers "loaded".

**Pins** are the user's alone. Each turn injects the pinned skills in full (`SKILL.md`, front matter
included, as `<skill id uri version>` under `## Skills`, sorted by id), discovery on or off. They are
read over a listing connection carrying the CALLER's permissions, so they need the caller's
`skills:read`. A skill the assistant reads itself (`read_resource` on its `skill://` URI) serves
that turn and its text stays in the history; it pins nothing. The injected `SKILL.md`s share one
budget, `CHAT_SKILLS_CONTENT_BUDGET_CHARS` (64 000), spent in stored order; a pin that is not
active, whose read fails or that does not fit renders one notice line instead.

**Discovery on**: the context lists the other skills of the turn's spaces, one line each (id,
version, URI, description), minus the pinned ones; the model loads a body on demand. A turn without
`mcp:read` ∧ `skills:read` is shown no listing. **Discovery off** withholds every `skills:*` from
the turn's permissions (`turnPermissions`): `read_resource` reads only injected skills, declaring or
writing a skill is refused, and the `## Skills` section says why.

**One definition per skill.** A turn works on drafts when package authoring is on and the caller
holds `skills:write` (`turnUsesDrafts`, shared by the turn and the composer's commands): then the
catalogue and the pins take the caller's draft when there is one, otherwise the published version.

The system prompt is ONE `cache_control` block, byte-identical across turns for the same state;
changing discovery or the pins, or editing a pinned skill, may miss the cache once.

**Why every turn, not once.** Claude Code and the Agent Skills loaders put an invoked skill into the
history once. A pin is re-injected from the system prompt on every turn instead: the chat's history
is bounded and summarized, so a skill injected once can fall out of it while the panel still shows
it pinned, which breaks the invariant above. The cached system block makes the repeat cost a cache
read, not new input.

## Stored state

`chat_sessions` carries `skill_discovery boolean`, `pinned_skills text[]` (sorted, deduplicated,
CHECK-capped at 5, no FK) and `skill_status jsonb`
(`{ [packageId]: { status: "injected" | "over_budget" | "unavailable" | "unreadable", chars } }`).

Every session DTO carries `skill_discovery` and `pins: [{ id, status, chars }]`, sorted by id.
`status` and `chars` are null for a pin no claimed turn has evaluated. Verdicts: `injected`;
`over_budget`; `unavailable` (in no `skills/list` of the turn's spaces); `unreadable` (a read
failed or answered malformed, a digest other than the listed one included). The turn that claims
the conversation writes them in the claim's own UPDATE, so a turn refused before the claim writes
none.

## Writes

`PATCH /api/orgs/{orgId}/chat/sessions/{id}/skills` takes `{ pins?, skill_discovery? }`, strict, at
least one field. `pins` replaces the whole set and drops the `skill_status` entries of removed pins.
It answers the session object (200), leaves `updatedAt` alone and signals the owner's other
clients. It is allowed while a turn runs and applies from the next turn.

`POST /api/orgs/{orgId}/chat` takes `pins` and `skill_discovery` only for the conversation it
creates (written by the INSERT) or an ephemeral turn; an existing conversation ignores them, as it
ignores `spaceId` and `restricted`. The claim is a compare-and-set on the origin space and the limit
alone: 409 `chat_turn_scope_changed` if they moved since the turn's read, 409 `chat_turn_in_flight`
if a live turn holds the conversation (answered first). Neither writes anything.

### Rationale

- **User-only pins**: an assistant read that pinned would add skills the user never chose, sharing
  their cap and budget.
- **PATCH of the full set**: the client always knows what was applied (the answer is the session),
  a change needs no message, and a fresh conversation's choices ride with its first `POST`, so
  choosing creates no conversation, row or navigation.
- **`status`/`chars` on the row**: the panel reads real state from the session DTO and never
  guesses; the turn that evaluates is the one that writes.
- **Arrays + CHECK, no child table**: a replace-on-write set read with the session row needs none.
- **One discovery switch**: `listSkills` and `resources/read` on a non-injected skill both answer to
  `skills:read`, so a separate listing-tool setting would not hold.

## UI

The skills panel and the `/` menu both read `GET /api/orgs/{orgId}/chat/commands` (with
`package_authoring`), so neither offers a definition the turn would not inject. The panel mounts
when `canPinSkills` holds (`chat:write` ∧ `skills:read`) and the session read succeeded. It has one
checkbox per skill (a skill cited in the draft is checked and locked: `aria-disabled`, still
focusable so its reason is read), each row loaded or not loaded with its reason, one footer line for
changes pending until the next message, one uncheck hint, the discovery switch, and a gauge of the
64 000-character budget that warns before a pin would exceed it. The client state is the session
DTO; realtime session updates cover the owner's other clients. An assistant `SKILL.md` read renders
in the thread as a « Lue pour ce message » chip with an « Épingler » action.

## Commands

`GET /api/orgs/{orgId}/chat/commands` (`?spaceId=` reads one space) lists the skills the
conversation can pin and the agents the caller can launch, as an MCP client reads the platform
server (`skills/list`, `prompts/list`) over one connection of the caller's own. `/<skill>` is only
the composer adding the id to the pins: no backend path of its own.

An agent launch is a `data-agent-prompt` part (`{ name, title }`) in the last user message. The
turn resolves it with `prompts/get` (the typed text as `request`) before taking the slot and the
claim and stores the instructions in the part's `data.text`, capped at 64 KB. The model reads that
text in place of the typed text. An unknown name or an oversized launch is a 400; a platform MCP
server that fails to answer is a 502. Later turns take earlier launch texts from the stored
`chat_messages` rows by message id, never from the browser's copy, most recent first within 64 000
characters, older ones becoming a stub.

## Out of scope

- Platform-provided skills the chat indexes by default, and the `unlisted` visibility that would
  keep them out of the catalogues. Each must be gated on the capability it teaches, and the
  `@appstrate` scope must be reserved at package creation first: the JSON create route accepts any
  `@scope`, so a new system id could collide with an organization package.
- Per-space default selection inherited by new sessions.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
