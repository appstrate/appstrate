# Skills in the chat

Implements issue #1309 (replaces the earlier attempts #851, #1126 and #1165).

## Problem

The chat could _name_ skills but never _use_ one, and its Pi session is
deliberately resource-free (`pi-chat/resource-loader.ts`: `noSkills`), so Pi's
native skill directory is not an option. Nothing could hide a package from a
catalogue either.

## Model

```
skills indexed for a turn =
    platform defaults            (module-chat constant, always)
  ∪ pinned on the session        (chat_sessions.pinned_skills)
  ∪ the space catalogue          (when chat_sessions.skill_catalogue)
skills loaded for a turn  = `/skill` mentions in the user messages
```

A caller without `skills:read` gets no skills index at all, platform defaults
included — `getSkill` would refuse every body anyway.

Two levels of loading, as in the Agent Skills spec:

- **Index** — one line per skill (id, version, label, description) in the
  `## Skills` section of the system prompt, deterministic order. The model
  loads a body on demand through `invoke_operation` → `getSkill`, which applies
  the platform's single definition-read rule (the draft when writable, else the
  latest published version).
- **Direct load** — a `/skill` mention puts the body in the _user turn text_,
  never in the system prompt.

The system prompt is ONE `cache_control` block: what renders there is
byte-identical across turns for the same session state (sorted, no clocks, no
counters); changing pins or the catalogue switch may miss the cache once.

Trust: a body is content the caller can already read, injected as user-turn
text; the `[Skill … loaded]` marker is a legibility aid, not a fence, and a
pasted directive resolves with the caller's own permissions.

## `unlisted` visibility

`_meta["dev.appstrate/visibility"].level = "unlisted"` (AFPS vendor extension).
One SQL predicate, `listedFilter()` (`apps/api/src/lib/package-helpers.ts`),
narrows the catalogue listings — in SQL, so caps and totals stay honest — at
four sites: `listOrgItems` (`services/package-items/crud.ts`),
`listActivePackageHints` and `listActivePackages` (`services/space-packages.ts`)
and `listIntegrations` (`services/integration-service.ts`).

- Not the library (`services/package-library.ts`), the management map: hiding
  an org's unlisted package there would leave it on no page at all.
- Exact-id reads (`getSkill`, `getAgent`, dependency and version resolution)
  are untouched. Visibility is discoverability, never authorization.
- Covered by integration tests on the listings, not by a predicate unit test.

## Caller context

`GET /api/me/context?skills=<comma-separated ids>` resolves the named skills by
exact id for the caller in the current space, unlisted included:
`requested_skills` (sorted) and `unresolved_skills` (unknown, inactive or out of
reach); a malformed id or more than 30 ids is a 400. One round trip.

## Platform default skills

`@appstrate/copilot`, `@appstrate/web-search` and `@appstrate/connector-choice`
are a constant in module-chat (`src/skills.ts`), shipped as system packages
(`scripts/system-packages/skill-*-1.0.0/`) marked unlisted. They are always
indexed, whatever the session state, and are offered neither in the picker nor
in the `/` popover. A default that does not resolve is an operator warning
(logged once per process), never a prompt line. These three skills are written
for the chat assistant — they read its `## Your context` block — which is why
they are unlisted platform defaults and not agent dependencies. Their bodies
carry only what the persona (`prompt.ts`) and the MCP server instructions
(`modules/mcp/router.ts`) do not already say.

Boot: the system-package sync upserts with `setWhere: isNull(orgId)` — it
refuses to overwrite an organization-owned row under the same id. The collision
is logged at error level (id, owning org, the fix: rename the org package),
reported in `ownershipConflicts`, and that system package is skipped — no row
write, no version registered, and the id is dropped from the system registry,
so the org keeps full control of its package; the boot continues. Pre-deploy check, on prod:
`SELECT id, org_id FROM packages WHERE id IN ('@appstrate/copilot', '@appstrate/web-search', '@appstrate/connector-choice');`
— any row with a non-null `org_id` must be renamed first.

## Per-conversation choice

Migration `0069` adds two columns to `chat_sessions`:

- `skill_catalogue boolean NOT NULL DEFAULT true` — whether the space
  catalogue is indexed;
- `pinned_skills text[] NOT NULL DEFAULT '{}'` — sorted, deduplicated, at most
  20, no FK. A pin that no longer resolves renders one notice line, and still
  shows in the picker so it can be removed.

Rejected: a `chat_session_skills` table (a replace-on-write set read with the
session row needs none); a three-mode enum ("pins only" removed 3 index lines).

`PUT /api/chat/sessions/{id}/skills` `{ skill_catalogue, pinned_skills }` → 204;
it creates the row for a client-minted id, as the first turn does — so a picker
write on a fresh conversation makes it appear in the sidebar with no messages —
and it never bumps `updatedAt`. Every session
DTO carries both fields. There is no chat-specific skill listing: the picker
and the `/` popover read `GET /api/packages/skills`.

UI: a picker in the composer (catalogue switch + one pin checkbox per skill).
The selection lives in local state seeded from the session detail; writes are
coalesced (one in flight, the newest wins) and reverted on failure.

## `/skill` mention

The `/` popover opens only when the catalogue has at least one skill matching
what follows the `/` (a bare `/` opens it only when the catalogue is non-empty). It
inserts the assistant-ui default directive `:skill[/name]{name=@scope/name}`,
persisted raw in the user message (audit trail) and rendered as a chip.

Every turn, module-chat parses the directives across all user messages and
re-reads the bodies through the in-process `getSkill` (the route re-checks
`skills:read`). Each directive is projected into the user turn text: the first
occurrence of an id becomes the body (capped at 32 KiB), later ones a
back-reference, a failure a one-line reason. At most 10 distinct skills are
mentioned per conversation.

Accepted trade-off: bodies are re-read, not frozen, so an edited or revoked
skill changes a history block that was already answered.

## Out of scope

- Per-space default skills inherited by new sessions.
- Exposing the platform defaults to external MCP clients through `get_me`.
- A dedicated `load_skill` MCP tool — measure `getSkill` first.
- `resolved_skill_versions` on runs and `dependency_overrides` (#1165).
- Scope reservation (follow-up): package creation does not reserve the org
  scope — the JSON create route accepts any `@scope`, so an organization can
  hold an `@appstrate/…` id. The boot sync only contains it (logs, skips the
  system package, keeps booting).
