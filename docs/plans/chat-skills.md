# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165); the
server-owned pins (sources, statuses, deltas, assistant loads) are #2356.

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option.

## Model

Each conversation has two skill settings, stored on `chat_sessions`:
`pinned_skills` (the pinned skills, whoever pinned them) and `skill_discovery` (default `true`).

**Invariant**: a skill shown as loaded is injected in the model's context. The server is the
only source of truth for the pins; the client never infers "loaded".

| `skill_discovery` | The model sees                                                  | Skill tools on the turn                     |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `true`            | the pinned skills in full, the other skills of the space listed | `read_resource`                             |
| `false`           | the pinned skills in full, nothing else                         | `read_resource` on the injected skills only |

**Discovery** is progressive disclosure, as in the Agent Skills spec: one line per
skill (id, version, `skill://` URI, description) under `## Skills`, the
entries of `skills/list` (the draft's entry first on a turn that works on drafts, see
"One definition per skill" below; otherwise the published entry), uncapped, minus the pinned skills (those are injected);
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
  the caller may read. On a turn that works on drafts a chosen skill takes its draft entry
  when there is one, else its published entry; a skill in neither list gets a notice.
- `resources/read` of each chosen skill's `SKILL.md` gives the content, the
  bytes every MCP client and `appstrate code sync` get at that URI.

**One definition per skill.** A turn works on drafts when package authoring is on and the
caller holds `skills:write` — `turnUsesDrafts` (`turn-permissions.ts`), the one predicate the
turn (`skillDrafts` in `chat-stream.ts`, the `drafts` argument of `buildCallerContextBlock`) and
the composer's commands (`GET …/chat/commands?package_authoring=`) share — whatever discovery. Then the catalogue, the injected pins and the
URIs an assistant load must read to pin (`skillUris`) all take the caller's draft when there is
one; otherwise all take the published version, and the drafts are not even listed (no draft
`skills/list` hop, so a failing one cannot make a pin unreadable). The turn can read each: a listed draft with the
`skills:write` it keeps, an injected one through its claim even with discovery off. So a load
of a listed URI always pins the definition later turns inject. With authoring off, a pinned
skill the caller has a draft of is injected at its published version.

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
  5, no FK;
- `assistant_skills text[] NOT NULL DEFAULT '{}'` — the part of `pinned_skills` the assistant
  pinned (migration 0113);
- `skill_status jsonb NOT NULL DEFAULT '{}'` — `{ [packageId]: "injected" | "over_budget" |
"unavailable" | "unreadable" }`, the verdict of the last turn that claimed the conversation
  on each pin it evaluated (a digest mismatch is `unreadable`).

Every write keeps `assistant_skills ⊆ pinned_skills` and `keys(skill_status) ⊆ pinned_skills`.
`ChatSkillSelection` carries the column names (`skillDiscovery`, `pinnedSkills`), so
a session row is a selection.

Every session DTO carries `skill_discovery` and `skills: [{ id, source: "user" | "assistant",
status }]`, sorted by id (`pinnedSkillsOf`); `status` is null for a pin no claimed turn has
evaluated yet.

### Statuses

`resolveChatSkills` (pure) gives each pin its verdict next to the injected skills and the
notices, and the budget the injected ones leave: `injected`; `over_budget`; `unavailable` — in
neither `skills/list` (published, drafts) of the turn's spaces, both answered; `unreadable` —
any read that failed (the connection, its deadline, a failed `skills/list` the pin may be
missing from, a refused or failed `resources/read`) or answered malformed (a blob, a digest
other than the listed one, a draft without `lock_version`). The turn that claims the
conversation writes exactly those verdicts in the claim's own UPDATE (`claimTurn` →
`setActiveStream`). A turn refused before the claim (admission gate, model binding, capacity,
cap) writes none; a turn that fails AFTER its claim (the engine, the stream) has written them
already, and they stand.

The claim is a compare-and-set on what the turn read: origin space, limit, `skill_discovery`
and the `pinned_skills` its prompt was built from, in order (`TurnScope`). A skill change from
another tab landing between the turn's upsert and its claim refuses the turn with 409
`chat_turn_scope_changed`; the resend reads the new state. So the verdicts always describe the
row's own pins. A live turn holding the conversation answers `chat_turn_in_flight` first,
whatever else moved.

### Assistant loads pin

A persisted turn's `read_resource` (and the platform `read` tool, through the same
`pinnedSkillReplay` helper) that answers text goes through the turn's `SkillLoad`
(`turnSkillLoad`, built in `chat-stream.ts` from the injected set, the budget left and
`skillUris` — each listed skill's `SKILL.md` URI as a pin would inject it — threaded to `buildPlatformMcpTools` as `skillLoad`):

- a URI that is not the `SKILL.md` the conversation injects for its skill (a file of the skill,
  another space's copy, a draft read when the published version is injected, or the reverse) is
  a plain read, its text kept in the replay;
- a skill this turn already injected (system prompt, or an earlier load) is read with no write;
- a text longer than the budget left this turn (64 000 minus the injected pins and the skills
  loaded this turn) throws a refusal, nothing marked. The share is reserved before the pin is
  awaited and given back when it is refused, and a parallel read of the same skill waits for
  that load, so Pi's parallel tool calls never spend the budget twice;
- else `pinAssistantSkill` appends it to `pinned_skills` + `assistant_skills` and marks it
  `injected`, in one UPDATE guarded on `cardinality(pinned_skills) < 5` (a skill the user
  already pinned keeps its source) and on `active_stream_id` still being this turn's stream:
  `full` (the cap, a lost race included) or `released` (the turn was stopped or taken over)
  refuse the load and write nothing.

The last two cases that succeed return the text for this turn and persist the read's receipts,
the `SKILL.md`'s own replaced by `{"uri","skill":"@scope/name","pinned":true}` (the other files a
`read` embedded keep their usual receipts): the skill is a pin either way, so a replay never
re-injects the body and the next turns inject it from the system prompt, where summarization
cannot drop it.

The refusals tell the model what happened and that the user can unpin a skill in the skills
panel. An ephemeral turn has no `SkillLoad`: its loads are plain reads. The `## Skills` listing
opens with the rule (loading pins, cap 5, one budget) and never lists a pin: an injected one is
shown in full, one left out has its notice.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the
session row needs none); a third setting for a listing tool distinct from
discovery: `listSkills` and `resources/read` on a skill the turn did not inject both answer to
`skills:read` alone, so discovery is one switch.

The selection rides the turn as CHANGES, never a full set: `POST /api/orgs/{orgId}/chat` takes
`skill_discovery`, `pin_skills` and `unpin_skills` (each optional, at most 5 ids), and
`ensureSession` applies them in the upsert that creates or claims the row, each column
computed from the row as the statement finds it — `pinned_skills` = (stored − unpin) ∪ pin,
a pin leaves `assistant_skills` (the user's now), an unpin leaves all three columns — so a
client that read the session before the assistant pinned cannot drop that pin, and re-sending
the same changes changes nothing. More than 5 pins as a result is a 400 naming `pin_skills`,
nothing written (the cap rides the conflict arm's `WHERE`). An ephemeral turn applies the
changes to the default selection. The changes are applied before the admission gate and the
claim, so a refused turn may still have written them; when they change an existing row, the
session-update signal tells the other tabs.

Accepted hazard: a request that fails before its response headers, after the server applied its
changes, looks refused to the client, which keeps its changes and re-sends them with the next
turn. Re-sending is idempotent, with one exception: if the turn's producer survived and the
assistant re-pinned a skill by loading it, the re-sent unpin of that skill drops the pin again.
The window is a lost response on a turn that kept running; the user sees the pin gone in the
panel and can pin it back. Absent, the stored selection stands (discovery on, no
pinned skill, for a new conversation). Nothing is written before the first message: choosing creates
no conversation, no sidebar row, no navigation, and there is no write to wait
for or to fail. A change made on an existing conversation and not followed by a
message is lost on reload — as a model choice is. There is no chat-specific skill listing: the picker reads
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
`skills:read`) and the session read succeeded. The client state is the session
DTO plus its local changes; it sends the changes and drops them once the turn
that carried them ended and the session detail was read again. Each row shows
the pin's real state and source (loaded by the user, by the assistant, cited in
the draft, or not loaded with its reason).

## Commands

The composer's `/` menu (#2173) lists the skills the conversation can pin and the agents the
caller can launch, read as an MCP client reads the platform server (`skills/list`,
`prompts/list`) over one connection of the caller's own: `GET /api/orgs/{orgId}/chat/commands`
(`?spaceId=` reads one space, as a limited conversation). `/<skill>` is only the composer
adding the id to the turn's `pin_skills`: no backend path of its own, no one-turn injection. The skills half takes
`package_authoring` (query, boolean, absent = on, as on `POST /chat`): it lists a skill's draft
under `turnUsesDrafts` alone, so the panel never offers a definition the turn would not inject
(a draft-only skill pinned with authoring off would otherwise be `unavailable`).

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
