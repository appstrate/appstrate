# Spaces

The org-scoped container everything else hangs off: a **space** owns the agents, skills and integrations placed in it, the runs those agents produce, the schedules that launch them, the end-users they act for, and the API keys that reach them. An organization is the billing/membership boundary; a space is the **scoping** boundary inside it. Every space-scoped request resolves exactly one space before a route handler sees it.

> **Naming.** This entity was called an _Application_ until the rename. "Application" was a false friend three times over: the codebase already uses it for the platform itself (`app-level security`, `apps/api`, `APP_URL`) and for a third-party OAuth application registered at Google or GitHub (`BYO-app`) — three senses, one word. The rename goes down to the physical layer: the table is `spaces`, the id prefix is `spc_`, the header is `X-Space-Id`, the permission resource is `spaces:*`, the storage-deletion reason is `space_deleted`, the CLI verb is `appstrate space`, and the French UI label is « Espace ». `packages/db/drizzle/0053_applications_to_spaces.sql` is the catalog half; `scripts/migration/0003-application-ids-to-space-ids.sql` is the row-value half, and **the two are one deploy** — see "Deploying the rename".

In the product, **Users / Utilisateurs** names everyone in the organization, including guests; **Members / Membres** names those who can access a space, whether their membership is explicit or implicit. The organization role `member` is displayed as **Standard user / Utilisateur standard**. Technical identifiers such as `org_members` and `space_members` remain unchanged; see the terminology in `RBAC_PERMISSIONS_SPEC.md`.

Core code: `apps/api/src/routes/spaces.ts` (routes), `apps/api/src/services/spaces.ts` (service), `apps/api/src/middleware/space-context.ts` (per-request resolution), `apps/api/src/lib/ids.ts` (id shape), `packages/db/src/schema/spaces.ts` (schema).

## Model

```
Organization ──┬── space_roles (org-defined permission bundles)
               ├── Space ──┬── space_members (explicit role per user)
               │           ├── Agents (via space_packages)
               │           ├── Runs ── Files
               │           ├── Schedules
               │           ├── Integrations (connections, OAuth clients, pins, org defaults)
               │           ├── End-users
               │           ├── API keys
               │           ├── Webhooks (level = "space")
               │           └── Notifications
               ├── Space … (one org, N team spaces, exactly one default)
               └── Personal space … (one per member, `owner_user_id` set)
```

A space is also the **unit of access**, not only of scoping: who reaches it is
answered by `spaces.visibility` (`open` / `closed` / `private`), `spaces.default_role`
and the `space_members` row for `(space, user)` — a preset (`admin` / `builder` /
`operator` / `runner` / `viewer`) or one of the org's `space_roles` bundles. Owners and
admins reach every TEAM space by org role and are never rows; a **personal**
space is the one exception and answers to its owner alone ("Personal spaces"
below). The resolver and the vocabulary live in
`docs/architecture/RBAC_PERMISSIONS_SPEC.md`; this page describes where it plugs
into space resolution.

The row itself is deliberately thin (`packages/db/src/schema/spaces.ts`): `id`, `org_id`, `name`, `is_default`, `settings` (jsonb), `created_by`, timestamps, plus the two columns that make a space PERSONAL — `owner_user_id` and `orphaned_at` ("Personal spaces" below). The only validated setting today is `allowedRedirectDomains` (`spaceSettingsSchema`, `apps/api/src/services/spaces.ts`), capped at 20 entries and checked through `validateDomainList` on both create and update (`apps/api/src/routes/spaces.ts`).

**Exactly one default per org, enforced in the catalog.** `idx_spaces_one_default` is a partial unique index on `org_id WHERE is_default = true` (`packages/db/src/schema/spaces.ts`) — a second default is a constraint violation, not a race the service has to win. The default is created with the org, idempotently: `createDefaultSpace` returns the existing default if there is one and otherwise mints `{ name: "Default", isDefault: true }` (`apps/api/src/services/spaces.ts`). It is called from org creation (`apps/api/src/routes/organizations.ts`) and from the first-run bootstrap hook (`apps/api/src/lib/post-bootstrap-hook.ts`); because it is idempotent, `/api/auth/bootstrap` can also re-run it to self-heal an org that somehow has none (`apps/api/src/routes/auth-bootstrap.ts`).

**Package reachability is per-space, not per-org.** `packages` is org-scoped and carries no `space_id`; the `space_packages` join row is what makes a package RUNNABLE from a space. `isPackageActiveHere` (`apps/api/src/services/space-packages.ts`) asks ONE question — is the package ACTIVE here — and the placement ROW always wins WHERE THE PACKAGE IS PLACED: `enabled` on the row when the space holds one and the package is homed or shared here, the deployment's default when there is no row (a **system** package, and for an integration the subset `SYSTEM_INTEGRATIONS` names). A row without a placement behind it decides nothing, here or anywhere else. It is one SQL expression, `activeHereSql(spaceId)` (`apps/api/src/services/package-activation.ts`), which conjoins the placement filter and expects both of its LEFT JOINs — `space_packages` and `package_shares`, each on (package, this space) — and it is shared with the caller-context hints, the library's `state`, the type INDEX pages and the space's own package reads, so the gate and what the model is told cannot drift. That sharing is what splits the two pages of a space: an INDEX renders the active set — what this space can launch — while the LIBRARY renders what is PLACED here and in what state, which is where an offer is taken up and a switched-off package is switched back on (`docs/architecture/RBAC_PERMISSIONS_SPEC.md` §6.8). The organization boundary lives in that same query rather than in each caller's next read. Two middlewares reach it, one question each (`apps/api/src/middleware/guards.ts`): `requireAgent()` asks PLACEMENT and answers the opaque `404 agent_not_found` for an agent this space cannot read at all, and every agent route mounts it; `requireActiveAgent()` asks the executable verdict (`agentExecutionBlock` — placed **and** active) and answers `404 agent_not_active_in_space` for an agent placed here and switched off, mounted behind the first by the three agent execution doors (`POST …/run` with its rerun, schedule creation, `GET …/bundle`). `POST /api/runs/remote` is the fourth door and reads the same verdict inline, and so does the scheduler tick. Same status either way, so a cross-space id leaks nothing. Every other agent route — the detail, the model, the proxy, the persistence, the runs and schedules listings, the readiness — is a READ or a per-space configuration and answers 200 with the switch off, carrying the verdict in the payload instead (`AgentDetail.active`); the index carries no such field, since it lists the active set and every row on it would answer `true`. That join row also carries the per-space configuration: the agent's stored input values and their locks (`input_settings` jsonb) and the model/proxy overrides (`packages/db/src/schema/packages.ts`). It carries no version — outside its home space a package runs its latest published version, and its draft runs for whoever may write it. The row is created by the first activation and is never deleted by a deactivation: switching a package off sets `enabled = false` and leaves every setting on it, so switching it back on costs nothing. Two acts drop the row, each along with the placement behind it: revoking the share that placed the package, and moving the home out with `keep_in_previous_home: false`. RUNNING is what the join row answers for; READING a package is a separate question with two placements of its own, the package's home and the spaces it is shared into (`docs/architecture/RBAC_PERMISSIONS_SPEC.md` §6.9).

## Personal spaces

**A personal space belongs to ONE member and to nobody else — an organization owner or admin neither reads nor writes it.** That is the whole point of the feature and it is the one place where "owners and admins reach every space" stops being true (`docs/architecture/RBAC_PERMISSIONS_SPEC.md` §3.6 is the authority; this section is where it plugs into space resolution). It is a **structural** property, not a visibility: `private` already means closed-and-hidden, and a private team space is still an administrative object.

**`spaces.owner_user_id` is what says so** (`packages/db/drizzle/0064_personal_spaces.sql`), and `resolveSpaceRole` (`apps/api/src/lib/space-role.ts`) reads it **before** the org role: a caller who is not the owner resolves NO role, so an admin's `admin`-by-org-role never fires. The owner holds preset `admin` there — except a `guest`, who holds `operator`: a guest is invited to USE one shared thing, and `admin` in a space of their own would let them author and launch arbitrary agents on the organization's LLM budget.

Three CHECKs make "personal" mean one thing, and a partial unique index makes it one per member:

| Constraint                                                         | What it forbids                                     |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| `spaces_personal_is_private`                                       | a personal space with any visibility but `private`  |
| `spaces_personal_not_default`                                      | a personal space as the org's default landing space |
| `spaces_orphaned_is_personal`                                      | `orphaned_at` on a team space                       |
| `uq_spaces_org_owner` (partial, `WHERE owner_user_id IS NOT NULL`) | a second personal space for the same member         |

That index is also the conflict target `ensurePersonalSpaceFor` (`apps/api/src/services/spaces.ts`) upserts on, which is what lets provisioning be ONE statement instead of a select-then-insert race. One is provisioned at every membership door (`provisionMember`, `apps/api/src/services/organizations.ts` — invitation acceptance and OIDC signup alike) and repaired for the caller's own on `GET /api/spaces`, so personal spaces exist from the first request the build serves. `scripts/migration/0015` only decides how many exist on day one, never whether any do.

**The caller's personal-space identity is not simply the authenticated user.** `callerPersonalOwnerId` (`apps/api/src/lib/view-as.ts`) answers the caller's id when the credential declares itself a `user` principal — whatever the transport (RBAC spec §7) — and `null` for a delegate, for an end-user and under a role preview: a key carries its creator's authority, not their privacy, and a persona has no private workspace. Every `resolveSpaceRole` call site passes it explicitly — there is no default, because a default would hand an API key its creator's private drafts.

**Visibility.** `isSpaceVisibleTo` (`apps/api/src/services/spaces.ts`) grants the listing and `GET /api/spaces/{id}` alike. A LIVE personal space is invisible to owners and admins — a 404, not a 403. The ONE exception is an **orphaned** one, which is listed to them with `access: "none"` precisely so somebody can decide what becomes of it.

**Offboarding is a window, not a deletion.** A member who leaves the org (`POST /api/orgs/{orgId}/leave`) or is removed from it goes through the same exit (`removeMemberInTx`, `apps/api/src/services/organizations.ts`; the full list of what it revokes is RBAC spec §3.6), which stamps `spaces.orphaned_at` instead of deleting and drops their explicit `space_members` rows; a re-invite inside the window clears it and hands the space back untouched. `PERSONAL_SPACE_GRACE_DAYS` is 30 (`apps/api/src/services/spaces.ts`) and the hourly `personal-space-sweeper` worker (`apps/api/src/services/personal-space-sweeper.ts`) closes it, one space per transaction, through the existing `deleteSpace` path with `actor: "sweeper"`. A package homed in a space being swept is **re-homed** to the org's default space when any other space still holds it, and deleted otherwise (`emptyAndDeletePersonalSpace` → `isPlacedElsewhere` / `reconcilePlacementsAfterRehome`, `apps/api/src/services/package-placement.ts`).

**Three administrative acts share ONE decision**, `assertSpaceAdminAct` (`apps/api/src/services/spaces.ts`), because a 409 naming a live personal space would be an existence ORACLE — it would confirm to an admin that a given id is somebody's private workspace, on a route where every other answer is 404:

| Act                                     | Team space                    | Own personal space                 | Orphaned personal space (owner/admin)                | Someone else's live personal space |
| --------------------------------------- | ----------------------------- | ---------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `DELETE /api/spaces/{id}`               | proceeds (400 on the default) | 409 `personal_space_not_deletable` | 409 — `sweep-now` is the route that empties it first | **404**                            |
| `POST /api/spaces/{id}/convert-to-team` | 409 `space_not_personal`      | 409 `personal_space_not_orphaned`  | proceeds, audited `space.converted_to_team`          | **404**                            |
| `POST /api/spaces/{id}/sweep-now`       | 409 `space_not_personal`      | 409 `personal_space_not_orphaned`  | proceeds, audited `space.swept`                      | **404**                            |

`delete` therefore never proceeds on a personal space at all; the sweeper reaches `deleteSpace` directly. `convert-to-team` is the transfer that keeps the contents, and it is refused on a LIVE personal space by design — nobody converts a workspace out from under its owner.

## The `spc_` id

`prefixedId("spc")` mints `spc_` + `crypto.randomUUID()` — a canonical lowercase dashed UUID and nothing else (`apps/api/src/lib/ids.ts`, used at `apps/api/src/services/spaces.ts`).

`SPACE_ID_RE` (`apps/api/src/lib/ids.ts`) pins exactly that shape:

```
/^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
```

**Why a regex guards an id the platform mints itself.** Because the prefix used to be `app_`, and without a shape check a surviving `app_` id does **not** fail — the header, the API key's bound id and the `spaces` row would all still agree with each other, so a half-finished data migration keeps working and says nothing. The regex turns that silence into a loud failure. It is the same reasoning that put `FILE_ID_RE` on the `file_` id (`packages/core/src/file-uri.ts`) in the previous rename.

`assertSpaceId(id, param)` (`apps/api/src/lib/ids.ts`) throws a 400 on anything else, and gives the `app_` case its **own message** so an operator reading the log can tell "a client sent garbage" apart from "the `app_` → `spc_` row rewrite has not run on this deployment":

> Space id 'app_…' uses the retired `app_` prefix. Space ids are `spc_` + a UUID; this deployment still holds pre-rename data — run the `app_` → `spc_` id migration.

**`app_` is rejected, never accepted-and-warned** (`docs/NO_TRANSITIONAL_CODE.md` §1). There is no alias, no widening, no fallback.

The CLI applies the same doctrine one layer out. A `config.toml` profile still pinning the retired `applicationId` key raises from `readConfig` rather than being silently dropped by the allow-list parse, because a silent drop would let the next `writeConfig` erase the user's pin from disk (`apps/cli/src/lib/config.ts`). `readConfig` is the **only** place that refusal exists, and reaching every command took one more step than putting it there: the commands that tolerate a missing profile — `appstrate run`, which must work from an `apst_…` API key with no profile at all — used to wrap the call in `.catch(() => null)` and so reported "requires a logged-in profile or an API key" at a user who was logged in. They now call `resolveActiveProfileOrNull`, which degrades an unreadable file to `null` but re-throws the module-local typed `RetiredProfileKeyError`. The check carries a hard expiry date, not a "once no profile still has it" condition nobody can observe.

## Resolving the space on the wire

`requireSpaceContext()` (`apps/api/src/middleware/space-context.ts`) runs for every core route family in `SPACE_SCOPED_PREFIXES` (same file) — `/api/agents`, `/api/runs`, `/api/schedules`, `/api/end-users`, `/api/api-keys`, `/api/notifications`, `/api/packages`, `/api/integrations`, `/api/uploads`, `/api/files`. It is wired in `apps/api/src/index.ts` behind the `isSpaceScopedPath` predicate, and the **same** predicate is read by the test harness — the list lived as two hand-kept copies until it was reconciled into one, because a route family added to one and not the other gives a test app whose scoping differs from production.

The list is core-only by design: a module owns space-scoping for its own routes (the webhooks module gates on an explicit `spaceId` body/query field instead — `apps/api/src/modules/webhooks/README.md`), so a module never adds a row to it.

Resolution order, symmetric with `requireOrgContext`:

| #   | Source                                         | Who uses it                                   |
| --- | ---------------------------------------------- | --------------------------------------------- |
| 1   | a `spaceId` already pinned by an auth strategy | API key, OIDC JWT, module strategies          |
| 2   | the `X-Space-Id` request header                | session auth — dashboard users                |
| 3   | the org's **default** space                    | the in-process MCP re-entry, and nothing else |

**A pinned space beats the header, and a disagreement is a 403** (`space-context.ts`). Without that check, a holder of a bearer token scoped to space A could send `X-Space-Id: B` for a second space in the same org and reach its data. Session callers never pin a space, so their header stays the primary signal.

**The default-space fallback is gated on the internal-dispatch marker** (`space-context.ts`). It exists solely for the MCP sub-dispatch: a per-org MCP bearer token pins the org but reaches a space-scoped route through an in-process `app.fetch()` re-entry that carries no `X-Space-Id`, so it resolves to the org's default space. That re-entry is identified by an unguessable per-process secret header (`x-appstrate-internal-dispatch`, 256 bits of CSPRNG minted once per boot, compared in constant time — `apps/api/src/lib/internal-dispatch.ts`). A direct caller — SPA or CLI — that omits the header gets a **400**, not a silent fallback to the default space (`space-context.ts`), which would weaken space isolation. It is the HEADER-LESS re-entry that falls back: the chat module's in-process loopback re-entry sends the session's `X-Space-Id` and so resolves at step 2, and its bearer declares `principalKind: "user"` (RBAC spec §7.4), so a turn started from the caller's personal space stays there instead of landing on the default one. The MCP router applies the same order for its own session scope (`apps/api/src/modules/mcp/router.ts`).

**Every path a space id can enter a request funnels through `validateSpaceInOrg` or `loadSpaceAccess`** (`apps/api/src/lib/space-lookup.ts`) — the middleware and the MCP router call the first, SSE auth the second — and both carry the shape guard, which is why it lives there rather than at each call site. The shape check runs **before** the SELECT: a `spc_` id that does not exist is a 404; a retired `app_` id is not a missing row, it is un-migrated data, and `assertSpaceId` says so. The paths that never pass through either are the three default-space fallbacks — `requireSpaceContext`, the module applier behind `enterSpaceContext` (both `space-context.ts`) and the MCP router's — where the id comes straight off the row, so each calls `assertSpaceId` explicitly, which is where an un-migrated `spaces` table would otherwise slip in unnoticed.

On success the middleware sets `c.set("spaceId", …)`, and `applySpacePermissions` sets `c.set("space", row)` — the `SpaceContextRow` (`apps/api/src/lib/space-lookup.ts`) it judged the caller's role on, so a service deciding for the caller takes the row that authorized the request rather than re-SELECTing it. A reader resolving OTHER users' roles (`listSpaceMembers`) re-reads the space with their rows in one statement instead (RBAC spec §4.4).

### The membership step

Validating that the space belongs to the org is half the job; the other half is what the caller may do **in** it. Right after `validateSpaceInOrg`, `applySpacePermissions` (`space-context.ts`) re-reads the space joined to the `space_members` row for `(spaceId, userId)` — one statement, so the two inputs are one snapshot (RBAC spec §4.4) — runs the resolver, and rewrites `c.set("permissions", …)` to `ceiling(orgPermissions ∪ spacePermissions)`; it also sets `c.set("spaceRole", ref)`. A guard downstream reads the same single `permissions` Set it always did.

No role in the space is a refusal, and which one depends on the visibility: **403 `not_a_space_member`** for `open` and `closed`, **404** for `private` — a private space does not exist for someone who is not in it, so the error must not confirm that it does. Outside a space, a caller holds org-level strings only, which is why a space-level guard can never pass on an org route.

`applySpacePermissions` is **exported**, because two families of routes are deliberately not in `SPACE_SCOPED_PREFIXES` and must reach the same code path: the spaces router itself (its per-space routes resolve the space from the PATH), and a module gating a space-level resource off its own `spaceId` field, which calls it through the core seam `enterSpaceContext` (`@appstrate/core/permissions`). A module that skips it holds no space-level string and its own guard can never pass — fail-closed, and the wrong behaviour.

The principal whose membership is resolved is `c.get("user")`: the subject under a session or dashboard token, and the **key's creator** under API-key auth (below). A caller with no `orgRole` — an OIDC end-user token, which carries a fixed allowlist and is never a space member — keeps whatever set its strategy wrote.

### API-key binding

`api_keys.space_id` is **NOT NULL** with `ON DELETE CASCADE` (`packages/db/src/schema/organizations.ts`): a key belongs to exactly one space for its whole life. The auth pipeline pins it straight from the key row (`apps/api/src/lib/auth-pipeline.ts`), which is why an API-key caller never sends `X-Space-Id` — and why sending a conflicting one is the 403 above.

Two consequences the routes enforce explicitly:

- `pinnedSpaceScopeGuard` (`apps/api/src/middleware/guards.ts`) rejects a request from a credential PINNED to a space — an API key, an OIDC end-user token — whose `:id`/`:spaceId` **path param** names a different one, the escape hatch a bound credential would otherwise have through the URL. It is mounted on `/:id` and `/:spaceId/*` of the spaces router (`apps/api/src/routes/spaces.ts`). It keys on the pinned space, not on the auth method: an end-user token pins a space and carries no `orgRole`, so `applySpacePermissions` returns early for it and nothing else compares the two (issue #1313). A caller that pins no space (session, OIDC instance token) passes through and is gated per space by `applySpacePermissions`.
- `GET /api/spaces` filters its result to the key's own space for API-key auth, and API keys cannot create spaces at all (`apps/api/src/routes/spaces.ts`).
- `Appstrate-User` impersonation resolves the end-user **inside the key's space** (`isEndUserInSpace`, `auth-pipeline.ts`); an `eu_` id from another space is a 403, not a 404-shaped miss.

**A key delegates its creator's standing in that space, live.** At mint, the requested scopes are validated against the creator's effective set in the key's space and filtered to it (`validateScopes`), so a `builder` cannot mint `api-keys:create`. On every request the pinned space goes through the membership step above with the **creator** as the principal, and the key's `scopes` as the ceiling. A creator who later loses the space — removed from it, or demoted to `guest` without a row — leaves the key with `scopes ∩ orgPermissions`, which 403s where it used to work. That is the live-ceiling semantics the API-key design already chose; there is no revocation sweep for losing a SPACE. Leaving or being removed from the ORG does revoke the creator's keys in it (`revoked_at`), so they cannot come back on a re-invite.

### Other transports

- **SSE** cannot send headers, so the realtime routes take `?spaceId=` for cookie auth and resolve it through `loadSpaceAccess`, the space and the caller's row in one statement (`apps/api/src/routes/realtime.ts`); API-key SSE uses the key's own space. Both parameters are declared in the spec as `SseSpaceId` / `XSpaceId` (`apps/api/src/openapi/parameters.ts`).
- **CLI** pins the space per profile (`spaceId` in `config.toml`) and manages it with `appstrate space` (`apps/cli/src/commands/space.ts`); headless callers set `APPSTRATE_SPACE_ID` (`apps/cli/src/commands/run.ts`).
- **SPA** keeps the active space in `localStorage` under `appstrate_current_space` (`apps/web/src/stores/space-store.ts`), and the typed API client's middleware injects it as `X-Space-Id` on every request.

## HTTP surface

Mounted at `/api/spaces` (`apps/api/src/index.ts`). The catalog verbs are gated by the **org-level** `spaces` resource — `spaces:read` (list) / `spaces:write` (create) / `spaces:delete`; editing ONE space is `space-settings:write` and its membership is `space-members:*`, both **space-level** and both held by preset `admin` only. Owners and admins hold the org half outright; members and guests hold `spaces:read` (`apps/api/src/lib/permissions.ts`).

| Method   | Path                                                  | Permission                  | Notes                                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/spaces`                                         | `spaces:read`               | Filtered per caller (below). Default first, then oldest-first                                                                                                                                                                                                                                                                                  |
| `POST`   | `/api/spaces`                                         | `spaces:write`              | 403 for API keys. The creator gets no row — they are an admin already                                                                                                                                                                                                                                                                          |
| `GET`    | `/api/spaces/{id}`                                    | `spaces:read`               | Visible exactly when the listing shows it; hidden is a 404                                                                                                                                                                                                                                                                                     |
| `PATCH`  | `/api/spaces/{id}`                                    | `space-settings:write`      | `name`, `settings`, `visibility`, `default_role`                                                                                                                                                                                                                                                                                               |
| `DELETE` | `/api/spaces/{id}`                                    | `spaces:delete`             | 400 on the default space. Never proceeds on a PERSONAL one — 409 `personal_space_not_deletable`, or 404 when it is not the caller's and still live (`assertSpaceAdminAct`, "Personal spaces" above)                                                                                                                                            |
| `POST`   | `/api/spaces/{id}/convert-to-team`                    | `spaces:write`              | Transfer: turns an ORPHANED personal space into an ordinary team space, keeping its contents. 403 for API keys. Audited `space.converted_to_team`                                                                                                                                                                                              |
| `POST`   | `/api/spaces/{id}/sweep-now`                          | `spaces:delete`             | Runs the offboarding routine on an ORPHANED personal space at once instead of waiting out the 30-day window; empties it and deletes it. 403 for API keys. Audited `space.swept`                                                                                                                                                                |
| `GET`    | `/api/spaces/{id}/members`                            | `space-members:read`        | Explicit rows always; the implicit ones (`source` `org_role` / `open_space`) are the org directory seen through a space and need `members:read` as well                                                                                                                                                                                        |
| `POST`   | `/api/spaces/{id}/members`                            | `space-members:invite`      | Exactly one of `userId`/`email`, plus one preset/custom role; existing org member only; 409 for org admin or existing row                                                                                                                                                                                                                      |
| `PATCH`  | `/api/spaces/{id}/members/{userId}`                   | `space-members:change-role` | Same either/or body; 404 when there is no explicit row                                                                                                                                                                                                                                                                                         |
| `DELETE` | `/api/spaces/{id}/members/{userId}`                   | `space-members:remove`      | Answers `access_after: "implicit" \| "none"`                                                                                                                                                                                                                                                                                                   |
| `GET`    | `/api/spaces/{id}/packages`                           | `spaces:read`               | Only package types the caller may read, within the credential ceiling                                                                                                                                                                                                                                                                          |
| `POST`   | `/api/spaces/{id}/packages`                           | per package TYPE            | ACTIVATE here. `agents:configure` / `skills:write` / `mcp-servers:write` / `integrations:install` — waived in the caller's own personal space. A package not yet placed here also needs `<type>:share` in its home; the share is then created with the activation. Idempotent: 201 when this call switched it on, 200 when it already was      |
| `GET`    | `/api/spaces/{id}/packages/{scope}/{name}`            | `spaces:read`               |                                                                                                                                                                                                                                                                                                                                                |
| `PUT`    | `/api/spaces/{id}/packages/{scope}/{name}`            | per package TYPE            | CONFIGURE only: `modelId` / `proxyId` / `generationConfig`, all three under `configure`, which the personal-space waiver never covers. The body is `.strict()` and carries no `enabled` — activation has its own pair of doors                                                                                                                 |
| `DELETE` | `/api/spaces/{id}/packages/{scope}/{name}`            | per package TYPE            | DEACTIVATE here — `enabled = false`, 204, the row and its settings kept; a package that is on by the deployment's default with no row gets one written `false` (the sticky opt-out), and one that is not on at all is a 404. `integrations:uninstall` for integrations, otherwise the `POST` string, waived in the caller's own personal space |
| `GET`    | `/api/spaces/{id}/packages/{scope}/{name}/run-config` | `agents:read`               | Resolved per-space config + overrides, in one call. No version: a space selects no definition                                                                                                                                                                                                                                                  |

**The listing is filtered, and every item carries the caller's standing.** An owner or admin sees every TEAM space; a member sees the `open` ones plus any `closed`/`private` one they hold a row in (a `closed` space is listed with `access: "none"` — visible, not enterable); a guest sees only the spaces they hold a row in; an API key sees its own space. **Personal spaces are the exception to all of it**: the caller's own is always listed, somebody else's is listed to nobody — an owner and an admin included — and the single exception is an ORPHANED one, which owners and admins see with `access: "none"` so they can convert or sweep it ("Personal spaces" above). Each item adds `visibility`, `default_role`, `access` (`"member" | "none"`), `role` (`{ kind, key, name }` or `null`) and `permissions` — the caller's effective set in that space, ceiling already applied — so a client decides what to render without re-deriving anything from a role name. Setting `visibility` to anything but `open` on the default space is a 400, and the DB check backs it.

`GET /api/spaces/{id}/roles` requires any of `space-members:invite`, `space-members:change-role` or `space-settings:write` and returns only roles whose effective grants fit the actor's space permissions. The same ceiling guards assigning roles, changing the implicit default, opening a space and removing a row that exposes a stronger implicit role. `POST` never overwrites an existing membership. Exact-email addition does not enumerate the org directory or send an invitation.

Member mutations record `space.member_added` / `space.member_role_changed` / `space.member_removed`. Someone who is not yet in the org is invited through `POST /api/orgs/{orgId}/members` with `space_assignments`, which applies the rows on accept.

**Wire shape.** The object discriminator is `object: "space"` (and `object: "space_package"` on the placement rows). Per `docs/CASING_CONVENTIONS.md`, four fields stay **camelCase** on the wire, under two different carve-outs: `id` and `spaceId` are universal DB-convention names (Carve-out 4b), while `isDefault` and `allowedRedirectDomains` are headless-platform DTO fields (Carve-out 4n). The domain fields on the space-package DTO are snake_case (`installed_at`, `package_type`, `package_source`, `draft_manifest`). The one projection the route does by hand is `created_by`: the Drizzle field is `createdBy` but `*By` is an actor reference, not a carve-out, so `toSpaceWire` renames it (`apps/api/src/routes/spaces.ts`). The two personal-space columns never travel as themselves. `owner_user_id` is COMPUTED away into the boolean `personal` — the caller either owns the space or cannot see it, so the id would name nobody they did not already know — and `orphaned_at` (snake_case, a domain timestamp like `last_run_at`, not a `createdAt`-family carve-out) is emitted only to an owner or admin, the two principals with an act to perform on it (`spaceWireForCaller`, `apps/api/src/routes/spaces.ts`).

Mutations record audit events with `resourceType: "space"` and actions `space.created` / `space.updated` / `space.deleted` (`apps/api/src/routes/spaces.ts`).

## Delete cascade

`deleteSpace` (`apps/api/src/services/spaces.ts`) runs the whole teardown in one transaction, in this order:

1. **Lock the organization**, then the space row, both `FOR UPDATE`. Org-first is the same lock order file and upload writes use; the parent lock is what stops a concurrent FK insert from being cascade-deleted without a matching deletion job.
2. **Refuse the default space** — `400 Cannot delete default space`. An org always has one.
3. **Enumerate the owned storage** before the FK cascade removes the rows that name it: `files`, `uploads`, and every run's workspace, each turned into a `storage_deletion_jobs` row with reason `space_deleted`.
4. **Account the bytes** — the freed `files.size` sum is decremented off `organizations.files_bytes_used` synchronously, under the org lock.
5. **Delete the row.** Postgres cascades the rest.

**Package artifacts are deliberately not enumerated**: `packages` is org-scoped and carries no `space_id`, so this cascade drops only the `space_packages` join rows — the package objects stay owned by the org and are purged by `deleteOrganization`.

Everything else follows the FK — except the last row, which since `0055` no longer has one. What each dependent does on a space delete:

| Table                                   | `space_id`    | On delete                                |
| --------------------------------------- | ------------- | ---------------------------------------- |
| `space_members`                         | NOT NULL (PK) | cascade                                  |
| `space_packages`                        | NOT NULL      | cascade                                  |
| `runs`                                  | NOT NULL      | cascade                                  |
| `package_schedules`                     | NOT NULL      | cascade                                  |
| `package_persistence`                   | NOT NULL      | cascade                                  |
| `end_users`                             | NOT NULL      | cascade                                  |
| `api_keys`                              | NOT NULL      | cascade                                  |
| `files`                                 | NOT NULL      | cascade (+ storage job)                  |
| `uploads`                               | NOT NULL      | cascade (+ storage job)                  |
| `notifications`                         | NOT NULL      | cascade                                  |
| `integration_connections`               | NOT NULL      | cascade                                  |
| `integration_oauth_clients`             | NOT NULL      | cascade                                  |
| `integration_pins`                      | NOT NULL      | cascade                                  |
| `integration_org_defaults`              | NOT NULL      | cascade                                  |
| `space_smtp_configs`                    | NOT NULL (PK) | cascade                                  |
| `space_social_providers`                | NOT NULL      | cascade                                  |
| `webhooks`                              | nullable      | cascade                                  |
| `oauth_clients` (`referenced_space_id`) | nullable      | cascade                                  |
| `audit_events`                          | nullable      | **no FK** — the value outlives the space |

Two of those columns are nullable because the row can be scoped at either level, and a CHECK ties the discriminator to the id: `webhooks` requires `(level = 'org' AND space_id IS NULL) OR (level = 'space' AND space_id IS NOT NULL)` (`packages/db/src/schema/webhooks.ts`), and `oauth_clients` carries the three-way `org` / `space` / `instance` version of the same rule (`packages/db/src/schema/oidc.ts`). `audit_events.space_id` is nullable for a different reason: it is not a foreign key at all (`packages/db/src/schema/audit.ts`), the same denormalised posture `org_id` has always had. It used to be one, with `ON DELETE SET NULL`, and that blanked the attribution of every historical row for a space the instant the space was deleted — the failure the table's own doc argues against, applied to the other tenancy column. `0055` dropped the constraint; the value now survives the delete, naming a space that no longer exists. Deleting a space must not erase the record that it was deleted.

## Deploying the rename

The rename ships as **two files that are one deploy**, and neither is a deploy on its own:

- `packages/db/drizzle/0053_applications_to_spaces.sql` — the **catalog** half. Table, column, constraint, index and `notify.ts` function renames. It rewrites no row value.
- `scripts/migration/0003-application-ids-to-space-ids.sql` — the **row-value** half, run by an operator in the same window (`docs/NO_TRANSITIONAL_CODE.md` §2 keeps one-off content rewrites out of drizzle). It re-mints `spaces.id` and every column that references it, plus the values that encode a space id or the retired word.

**Their headers are the authority on how, in what order, and what is deliberately left alone** — the seventeen foreign keys and why the drop/restore is catalog-driven, why the `level` rewrite must precede the id rewrite, which triggers are disabled and why, what is verified before and after, and the promotion of the three CHECK constraints `0053` was forced to add `NOT VALID` (which `0003` performs itself, guarded, inside its own transaction — there is no manual post-deploy step). Read them there, not here: this page describes the space model, which outlives the rename, while those two files describe a migration that stops being true the moment it is applied. Restating any of it here would make a third source that can disagree with the other two, and has.
