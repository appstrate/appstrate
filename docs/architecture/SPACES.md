# Spaces

The org-scoped container everything else hangs off: a **space** owns the agents, skills and integrations an org has installed, the runs those agents produce, the schedules that launch them, the end-users they act for, and the API keys that reach them. An organization is the billing/membership boundary; a space is the **scoping** boundary inside it. Every space-scoped request resolves exactly one space before a route handler sees it.

> **Naming.** This entity was called an _Application_ until the rename. "Application" was a false friend three times over: the codebase already uses it for the platform itself (`app-level security`, `apps/api`, `APP_URL`) and for a third-party OAuth application registered at Google or GitHub (`BYO-app`) — three senses, one word. The rename goes down to the physical layer: the table is `spaces`, the id prefix is `spc_`, the header is `X-Space-Id`, the permission resource is `spaces:*`, the storage-deletion reason is `space_deleted`, the CLI verb is `appstrate space`, and the French UI label is « Espace ». `packages/db/drizzle/0053_applications_to_spaces.sql` is the catalog half; `scripts/migration/0003-application-ids-to-space-ids.sql` is the row-value half, and **the two are one deploy** — see "Deploying the rename".

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
               └── Space … (one org, N spaces, exactly one default)
```

A space is also the **unit of access**, not only of scoping: who reaches it is
answered by `spaces.visibility` (`open` / `closed` / `private`), `spaces.default_role`
and the `space_members` row for `(space, user)` — a preset (`admin` / `builder` /
`operator` / `viewer`) or one of the org's `space_roles` bundles. Owners and
admins reach every space by org role and are never rows. The resolver and the
vocabulary live in `docs/architecture/RBAC_PERMISSIONS_SPEC.md`; this page
describes where it plugs into space resolution.

The row itself is deliberately thin (`packages/db/src/schema/spaces.ts:17`): `id`, `org_id`, `name`, `is_default`, `settings` (jsonb), `created_by`, timestamps. The only validated setting today is `allowedRedirectDomains` (`spaceSettingsSchema`, `apps/api/src/services/spaces.ts:15`), capped at 20 entries and checked through `validateDomainList` on both create and update (`apps/api/src/routes/spaces.ts:110`, `:157`).

**Exactly one default per org, enforced in the catalog.** `idx_spaces_one_default` is a partial unique index on `org_id WHERE is_default = true` (`packages/db/src/schema/spaces.ts:35`) — a second default is a constraint violation, not a race the service has to win. The default is created with the org, idempotently: `createDefaultSpace` returns the existing default if there is one and otherwise mints `{ name: "Default", isDefault: true }` (`apps/api/src/services/spaces.ts:47`). It is called from org creation (`apps/api/src/routes/organizations.ts:160`) and from the first-run bootstrap hook (`apps/api/src/lib/post-bootstrap-hook.ts:37`); because it is idempotent, `/api/auth/bootstrap` can also re-run it to self-heal an org that somehow has none (`apps/api/src/routes/auth-bootstrap.ts:296`).

**Package reachability is per-space, not per-org.** `packages` is org-scoped and carries no `space_id`; the `space_packages` join row is what makes a package reachable from a space. `hasPackageAccess` (`apps/api/src/services/space-packages.ts:405`) admits a package when it is a **system** package (`packages.source = 'system'`, visible in every space) **or** has a `space_packages` row for that space; `getPackageWithAccess` (`apps/api/src/services/package-catalog.ts:150`) is the single loader that applies it, and returns `null` for both "not found" and "not reachable" so a cross-space id leaks nothing. That join row also carries the per-space configuration: the agent's stored input values and their locks (`input_settings` jsonb), the model/proxy overrides and the version pin (`packages/db/src/schema/packages.ts:24`).

## The `spc_` id

`prefixedId("spc")` mints `spc_` + `crypto.randomUUID()` — a canonical lowercase dashed UUID and nothing else (`apps/api/src/lib/ids.ts:6`, used at `apps/api/src/services/spaces.ts:27`).

`SPACE_ID_RE` (`apps/api/src/lib/ids.ts:34`) pins exactly that shape:

```
/^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
```

**Why a regex guards an id the platform mints itself.** Because the prefix used to be `app_`, and without a shape check a surviving `app_` id does **not** fail — the header, the API key's bound id and the `spaces` row would all still agree with each other, so a half-finished data migration keeps working and says nothing. The regex turns that silence into a loud failure. It is the same reasoning that put `FILE_ID_RE` on the `file_` id (`packages/core/src/file-uri.ts`) in the previous rename.

`assertSpaceId(id, param)` (`apps/api/src/lib/ids.ts:44`) throws a 400 on anything else, and gives the `app_` case its **own message** (`:46`) so an operator reading the log can tell "a client sent garbage" apart from "the `app_` → `spc_` row rewrite has not run on this deployment":

> Space id 'app_…' uses the retired `app_` prefix. Space ids are `spc_` + a UUID; this deployment still holds pre-rename data — run the `app_` → `spc_` id migration.

**`app_` is rejected, never accepted-and-warned** (`docs/NO_TRANSITIONAL_CODE.md` §1). There is no alias, no widening, no fallback.

The CLI applies the same doctrine one layer out. A `config.toml` profile still pinning the retired `applicationId` key raises from `readConfig` rather than being silently dropped by the allow-list parse, because a silent drop would let the next `writeConfig` erase the user's pin from disk (`apps/cli/src/lib/config.ts:149`). `readConfig` is the **only** place that refusal exists, and reaching every command took one more step than putting it there: the commands that tolerate a missing profile — `appstrate run`, which must work from an `ask_…` API key with no profile at all — used to wrap the call in `.catch(() => null)` and so reported "requires a logged-in profile or an API key" at a user who was logged in. They now call `resolveActiveProfileOrNull` (`:248`), which degrades an unreadable file to `null` but re-throws the module-local typed `RetiredProfileKeyError` (`:52`). The check carries a hard expiry date, not a "once no profile still has it" condition nobody can observe.

## Resolving the space on the wire

`requireSpaceContext()` (`apps/api/src/middleware/space-context.ts:136`) runs for every core route family in `SPACE_SCOPED_PREFIXES` (`:32`) — `/api/agents`, `/api/runs`, `/api/schedules`, `/api/end-users`, `/api/api-keys`, `/api/notifications`, `/api/packages`, `/api/integrations`, `/api/uploads`, `/api/files`. It is wired in `apps/api/src/index.ts:214` behind the `isSpaceScopedPath` predicate (`:218`), and the **same** predicate is read by the test harness — the list lived as two hand-kept copies until it was reconciled into one, because a route family added to one and not the other gives a test app whose scoping differs from production.

The list is core-only by design: a module owns space-scoping for its own routes (the webhooks module gates on an explicit `spaceId` body/query field instead — `apps/api/src/modules/webhooks/README.md:28`), so a module never adds a row to it.

Resolution order, symmetric with `requireOrgContext`:

| #   | Source                                         | Who uses it                                   |
| --- | ---------------------------------------------- | --------------------------------------------- |
| 1   | a `spaceId` already pinned by an auth strategy | API key, OIDC JWT, module strategies          |
| 2   | the `X-Space-Id` request header                | session auth — dashboard users                |
| 3   | the org's **default** space                    | the in-process MCP re-entry, and nothing else |

**A pinned space beats the header, and a disagreement is a 403** (`space-context.ts:141`). Without that check, a holder of a bearer token scoped to space A could send `X-Space-Id: B` for a second space in the same org and reach its data. Session callers never pin a space, so their header stays the primary signal.

**The default-space fallback is gated on the internal-dispatch marker** (`space-context.ts:161`). It exists solely for the MCP sub-dispatch: a per-org MCP bearer token pins the org but reaches a space-scoped route through an in-process `app.fetch()` re-entry that carries no `X-Space-Id`, so it resolves to the org's default space. That re-entry is identified by an unguessable per-process secret header (`x-appstrate-internal-dispatch`, 256 bits of CSPRNG minted once per boot, compared in constant time — `apps/api/src/lib/internal-dispatch.ts:37`). A direct caller — SPA or CLI — that omits the header gets a **400**, not a silent fallback to the default space (`space-context.ts:174`), which would weaken space isolation. The MCP router applies the same order for its own session scope (`apps/api/src/modules/mcp/router.ts:187`).

**Every path a space id can enter a request funnels through `validateSpaceInOrg`** (`space-context.ts:74`) — the middleware, SSE auth and the MCP router all call it — which is why the shape guard lives there rather than at each call site. The shape check runs **before** the SELECT: a `spc_` id that does not exist is a 404; a retired `app_` id is not a missing row, it is un-migrated data, and `assertSpaceId` says so. The one path that never passes through it is the default-space fallback, where the id comes straight off the row — so `assertSpaceId(active.id)` is called there explicitly (`space-context.ts:167`), which is where an un-migrated `spaces` table would otherwise slip in unnoticed.

On success the middleware sets both `c.set("spaceId", …)` and `c.set("space", row)` — the resolved `{ id, orgId, isDefault, visibility, defaultRole }` (`SpaceContextRow`, `space-context.ts`), so a service called from a space-scoped route takes the row rather than re-SELECTing it.

### The membership step

Validating that the space belongs to the org is half the job; the other half is what the caller may do **in** it. Right after `validateSpaceInOrg`, `applySpacePermissions` (`space-context.ts`) loads the `space_members` row for `(spaceId, userId)` — one lookup on the composite primary key — runs the resolver, and rewrites `c.set("permissions", …)` to `ceiling(orgPermissions ∪ spacePermissions)`; it also sets `c.set("spaceRole", ref)`. A guard downstream reads the same single `permissions` Set it always did.

No role in the space is a refusal, and which one depends on the visibility: **403 `not_a_space_member`** for `open` and `closed`, **404** for `private` — a private space does not exist for someone who is not in it, so the error must not confirm that it does. Outside a space, a caller holds org-level strings only, which is why a space-level guard can never pass on an org route.

`applySpacePermissions` is **exported**, because two families of routes are deliberately not in `SPACE_SCOPED_PREFIXES` and must reach the same code path: the spaces router itself (its per-space routes resolve the space from the PATH), and a module gating a space-level resource off its own `spaceId` field, which calls it through the core seam `enterSpaceContext` (`@appstrate/core/permissions`). A module that skips it holds no space-level string and its own guard can never pass — fail-closed, and the wrong behaviour.

The principal whose membership is resolved is `c.get("user")`: the subject under a session or dashboard token, and the **key's creator** under API-key auth (below). A caller with no `orgRole` — an OIDC end-user token, which carries a fixed allowlist and is never a space member — keeps whatever set its strategy wrote.

### API-key binding

`api_keys.space_id` is **NOT NULL** with `ON DELETE CASCADE` (`packages/db/src/schema/organizations.ts:133`): a key belongs to exactly one space for its whole life. The auth pipeline pins it straight from the key row (`apps/api/src/lib/auth-pipeline.ts:182`), which is why an API-key caller never sends `X-Space-Id` — and why sending a conflicting one is the 403 above.

Two consequences the routes enforce explicitly:

- `apiKeySpaceScopeGuard` (`apps/api/src/middleware/guards.ts:115`) rejects an API-key request whose `:id`/`:spaceId` **path param** names a different space — the escape hatch a bound key would otherwise have through the URL. It is mounted on `/:id` and `/:spaceId/*` of the spaces router (`apps/api/src/routes/spaces.ts:86`).
- `GET /api/spaces` filters its result to the key's own space for API-key auth, and API keys cannot create spaces at all (`apps/api/src/routes/spaces.ts:95`, `:103`).
- `Appstrate-User` impersonation resolves the end-user **inside the key's space** (`isEndUserInSpace`, `auth-pipeline.ts:196`); an `eu_` id from another space is a 403, not a 404-shaped miss.

**A key delegates its creator's standing in that space, live.** At mint, the requested scopes are validated against the creator's effective set in the key's space and filtered to it (`validateScopes`), so a `builder` cannot mint `api-keys:create`. On every request the pinned space goes through the membership step above with the **creator** as the principal, and the key's `scopes` as the ceiling. A creator who later loses the space — removed from it, or demoted to `guest` without a row — leaves the key with `scopes ∩ orgPermissions`, which 403s where it used to work. That is the live-ceiling semantics the API-key design already chose; there is no revocation sweep.

### Other transports

- **SSE** cannot send headers, so the realtime routes take `?spaceId=` for cookie auth and resolve it through the same `validateSpaceInOrg` (`apps/api/src/routes/realtime.ts:150`); API-key SSE uses the key's own space (`:125`). Both parameters are declared in the spec as `SseSpaceId` / `XSpaceId` (`apps/api/src/openapi/parameters.ts:76`, `:92`).
- **CLI** pins the space per profile (`spaceId` in `config.toml`) and manages it with `appstrate space` (`apps/cli/src/commands/space.ts`); headless callers set `APPSTRATE_SPACE_ID` (`apps/cli/src/commands/run.ts:886`).
- **SPA** keeps the active space in `localStorage` under `appstrate_current_space` (`apps/web/src/stores/space-store.ts:5`), and the typed API client's middleware injects it as `X-Space-Id` on every request.

## HTTP surface

Mounted at `/api/spaces` (`apps/api/src/index.ts`). The catalog verbs are gated by the **org-level** `spaces` resource — `spaces:read` (list) / `spaces:write` (create) / `spaces:delete`; editing ONE space is `space-settings:write` and its membership is `space-members:*`, both **space-level** and both held by preset `admin` only. Owners and admins hold the org half outright; members and guests hold `spaces:read` (`apps/api/src/lib/permissions.ts`).

| Method   | Path                                                  | Permission                  | Notes                                                                                                                                                   |
| -------- | ----------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/spaces`                                         | `spaces:read`               | Filtered per caller (below). Default first, then oldest-first                                                                                           |
| `POST`   | `/api/spaces`                                         | `spaces:write`              | 403 for API keys. The creator gets no row — they are an admin already                                                                                   |
| `GET`    | `/api/spaces/{id}`                                    | `spaces:read`               | Visible exactly when the listing shows it; hidden is a 404                                                                                              |
| `PATCH`  | `/api/spaces/{id}`                                    | `space-settings:write`      | `name`, `settings`, `visibility`, `default_role`                                                                                                        |
| `DELETE` | `/api/spaces/{id}`                                    | `spaces:delete`             | 400 on the default space                                                                                                                                |
| `GET`    | `/api/spaces/{id}/members`                            | `space-members:read`        | Explicit rows always; the implicit ones (`source` `org_role` / `open_space`) are the org directory seen through a space and need `members:read` as well |
| `POST`   | `/api/spaces/{id}/members`                            | `space-members:invite`      | Exactly one of `userId`/`email`, plus one preset/custom role; existing org member only; 409 for org admin or existing row                               |
| `PATCH`  | `/api/spaces/{id}/members/{userId}`                   | `space-members:change-role` | Same either/or body; 404 when there is no explicit row                                                                                                  |
| `DELETE` | `/api/spaces/{id}/members/{userId}`                   | `space-members:remove`      | Answers `access_after: "implicit" \| "none"`                                                                                                            |
| `GET`    | `/api/spaces/{id}/packages`                           | `spaces:read`               | listing is package-type agnostic                                                                                                                        |
| `POST`   | `/api/spaces/{id}/packages`                           | per package TYPE            | `agents:configure` / `skills:write` / `mcp-servers:write` / `integrations:install`                                                                      |
| `GET`    | `/api/spaces/{id}/packages/{scope}/{name}`            | `spaces:read`               |                                                                                                                                                         |
| `PUT`    | `/api/spaces/{id}/packages/{scope}/{name}`            | per package TYPE            | model, proxy, generation config, version pin — same strings as `POST`                                                                                   |
| `DELETE` | `/api/spaces/{id}/packages/{scope}/{name}`            | per package TYPE            | `integrations:uninstall` for integrations, otherwise the `POST` string                                                                                  |
| `GET`    | `/api/spaces/{id}/packages/{scope}/{name}/run-config` | `agents:read`               | Resolved per-space config + overrides + pin, in one call                                                                                                |

**The listing is filtered, and every item carries the caller's standing.** An owner or admin sees every space; a member sees the `open` ones plus any `closed`/`private` one they hold a row in (a `closed` space is listed with `access: "none"` — visible, not enterable); a guest sees only the spaces they hold a row in; an API key sees its own space. Each item adds `visibility`, `default_role`, `access` (`"member" | "none"`), `role` (`{ kind, key, name }` or `null`) and `permissions` — the caller's effective set in that space, ceiling already applied — so a client decides what to render without re-deriving anything from a role name. Setting `visibility` to anything but `open` on the default space is a 400, and the DB check backs it.

`GET /api/spaces/{id}/roles` requires any of `space-members:invite`, `space-members:change-role` or `space-settings:write` and returns only roles whose effective grants fit the actor's space permissions. The same ceiling guards assigning roles, changing the implicit default, opening a space and removing a row that exposes a stronger implicit role. `POST` never overwrites an existing membership. Exact-email addition does not enumerate the org directory or send an invitation.

Member mutations record `space.member_added` / `space.member_role_changed` / `space.member_removed`. Someone who is not yet in the org is invited through `POST /api/orgs/{orgId}/members` with `space_assignments`, which applies the rows on accept.

**Wire shape.** The object discriminator is `object: "space"` (and `object: "space_package"` on the install rows). Per `docs/CASING_CONVENTIONS.md`, four fields stay **camelCase** on the wire, under two different carve-outs: `id` and `spaceId` are universal DB-convention names (Carve-out 4b), while `isDefault` and `allowedRedirectDomains` are headless-platform DTO fields (Carve-out 4n). The domain fields on the space-package DTO are snake_case (`version_id`, `installed_at`, `package_type`, `package_source`). The one projection the route does by hand is `created_by`: the Drizzle field is `createdBy` but `*By` is an actor reference, not a carve-out, so `toSpaceWire` renames it (`apps/api/src/routes/spaces.ts:46`).

Mutations record audit events with `resourceType: "space"` and actions `space.created` / `space.updated` / `space.deleted` (`apps/api/src/routes/spaces.ts:118`, `:165`, `:189`).

## Delete cascade

`deleteSpace` (`apps/api/src/services/spaces.ts:119`) runs the whole teardown in one transaction, in this order:

1. **Lock the organization**, then the space row, both `FOR UPDATE` (`:125`, `:133`). Org-first is the same lock order file and upload writes use; the parent lock is what stops a concurrent FK insert from being cascade-deleted without a matching deletion job.
2. **Refuse the default space** — `400 Cannot delete default space` (`:140`). An org always has one.
3. **Enumerate the owned storage** before the FK cascade removes the rows that name it: `files`, `uploads`, and every run's workspace (`:142`–`:150`), each turned into a `storage_deletion_jobs` row with reason `space_deleted` (`:154`, `:158`).
4. **Account the bytes** — the freed `files.size` sum is decremented off `organizations.files_bytes_used` synchronously, under the org lock (`:167`).
5. **Delete the row.** Postgres cascades the rest.

**Package artifacts are deliberately not enumerated** (`:160`): `packages` is org-scoped and carries no `space_id`, so this cascade drops only the `space_packages` join rows — the package objects stay owned by the org and are purged by `deleteOrganization`.

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

Two of those columns are nullable because the row can be scoped at either level, and a CHECK ties the discriminator to the id: `webhooks` requires `(level = 'org' AND space_id IS NULL) OR (level = 'space' AND space_id IS NOT NULL)` (`packages/db/src/schema/webhooks.ts:66`), and `oauth_clients` carries the three-way `org` / `space` / `instance` version of the same rule (`packages/db/src/schema/oidc.ts:132`). `audit_events.space_id` is nullable for a different reason: it is not a foreign key at all (`packages/db/src/schema/audit.ts`), the same denormalised posture `org_id` has always had. It used to be one, with `ON DELETE SET NULL`, and that blanked the attribution of every historical row for a space the instant the space was deleted — the failure the table's own doc argues against, applied to the other tenancy column. `0055` dropped the constraint; the value now survives the delete, naming a space that no longer exists. Deleting a space must not erase the record that it was deleted.

## Deploying the rename

The rename ships as **two files that are one deploy**, and neither is a deploy on its own:

- `packages/db/drizzle/0053_applications_to_spaces.sql` — the **catalog** half. Table, column, constraint, index and `notify.ts` function renames. It rewrites no row value.
- `scripts/migration/0003-application-ids-to-space-ids.sql` — the **row-value** half, run by an operator in the same window (`docs/NO_TRANSITIONAL_CODE.md` §2 keeps one-off content rewrites out of drizzle). It re-mints `spaces.id` and every column that references it, plus the values that encode a space id or the retired word.

**Their headers are the authority on how, in what order, and what is deliberately left alone** — the seventeen foreign keys and why the drop/restore is catalog-driven, why the `level` rewrite must precede the id rewrite, which triggers are disabled and why, what is verified before and after, and the promotion of the three CHECK constraints `0053` was forced to add `NOT VALID` (which `0003` performs itself, guarded, inside its own transaction — there is no manual post-deploy step). Read them there, not here: this page describes the space model, which outlives the rename, while those two files describe a migration that stops being true the moment it is applied. Restating any of it here would make a third source that can disagree with the other two, and has.
