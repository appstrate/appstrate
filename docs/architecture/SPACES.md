# Spaces

The org-scoped container everything else hangs off: a **space** owns the agents, skills and integrations an org has installed, the runs those agents produce, the schedules that launch them, the end-users they act for, and the API keys that reach them. An organization is the billing/membership boundary; a space is the **scoping** boundary inside it. Every space-scoped request resolves exactly one space before a route handler sees it.

> **Naming.** This entity was called an _Application_ until the rename. "Application" was a false friend three times over: the codebase already uses it for the platform itself (`app-level security`, `apps/api`, `APP_URL`) and for a third-party OAuth application registered at Google or GitHub (`BYO-app`) — three senses, one word. The rename goes down to the physical layer: the table is `spaces`, the id prefix is `spc_`, the header is `X-Space-Id`, the permission resource is `spaces:*`, the storage-deletion reason is `space_deleted`, the CLI verb is `appstrate space`, and the French UI label is « Espace ». `packages/db/drizzle/0053_applications_to_spaces.sql` is the catalog half; `scripts/migration/0003-application-ids-to-space-ids.sql` is the row-value half, and **the two are one deploy** — see "Deploying the rename".

Core code: `apps/api/src/routes/spaces.ts` (routes), `apps/api/src/services/spaces.ts` (service), `apps/api/src/middleware/space-context.ts` (per-request resolution), `apps/api/src/lib/ids.ts` (id shape), `packages/db/src/schema/spaces.ts` (schema).

## Model

```
Organization ──┬── Space ──┬── Agents (via space_packages)
               │           ├── Runs ── Files
               │           ├── Schedules
               │           ├── Integrations (connections, OAuth clients, pins, org defaults)
               │           ├── End-users
               │           ├── API keys
               │           ├── Webhooks (level = "space")
               │           └── Notifications
               └── Space … (one org, N spaces, exactly one default)
```

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

**`app_` is rejected, never accepted-and-warned** (`docs/NO_TRANSITIONAL_CODE.md` §1). There is no alias, no widening, no fallback. The CLI applies the same doctrine one layer out: a `config.toml` profile still pinning the retired `applicationId` key raises rather than being silently dropped by the allow-list parse, because a silent drop would let the next `writeConfig` erase the user's pin from disk (`apps/cli/src/lib/config.ts:124`).

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

On success the middleware sets both `c.set("spaceId", …)` and `c.set("space", row)` — the resolved `{ id, orgId, isDefault }` (`SpaceContextRow`, `space-context.ts:55`), so a service called from a space-scoped route takes the row rather than re-SELECTing it.

### API-key binding

`api_keys.space_id` is **NOT NULL** with `ON DELETE CASCADE` (`packages/db/src/schema/organizations.ts:133`): a key belongs to exactly one space for its whole life. The auth pipeline pins it straight from the key row (`apps/api/src/lib/auth-pipeline.ts:182`), which is why an API-key caller never sends `X-Space-Id` — and why sending a conflicting one is the 403 above.

Two consequences the routes enforce explicitly:

- `apiKeySpaceScopeGuard` (`apps/api/src/middleware/guards.ts:115`) rejects an API-key request whose `:id`/`:spaceId` **path param** names a different space — the escape hatch a bound key would otherwise have through the URL. It is mounted on `/:id` and `/:spaceId/*` of the spaces router (`apps/api/src/routes/spaces.ts:86`).
- `GET /api/spaces` filters its result to the key's own space for API-key auth, and API keys cannot create spaces at all (`apps/api/src/routes/spaces.ts:95`, `:103`).
- `Appstrate-User` impersonation resolves the end-user **inside the key's space** (`isEndUserInSpace`, `auth-pipeline.ts:196`); an `eu_` id from another space is a 403, not a 404-shaped miss.

### Other transports

- **SSE** cannot send headers, so the realtime routes take `?spaceId=` for cookie auth and resolve it through the same `validateSpaceInOrg` (`apps/api/src/routes/realtime.ts:150`); API-key SSE uses the key's own space (`:125`). Both parameters are declared in the spec as `SseSpaceId` / `XSpaceId` (`apps/api/src/openapi/parameters.ts:76`, `:92`).
- **CLI** pins the space per profile (`spaceId` in `config.toml`) and manages it with `appstrate space` (`apps/cli/src/commands/space.ts`); headless callers set `APPSTRATE_SPACE_ID` (`apps/cli/src/commands/run.ts:886`).
- **SPA** keeps the active space in `localStorage` under `appstrate_current_space` (`apps/web/src/stores/space-store.ts:5`), and the typed API client's middleware injects it as `X-Space-Id` on every request.

## HTTP surface

Mounted at `/api/spaces` (`apps/api/src/index.ts:356`). All CRUD is gated by the `spaces` RBAC resource — `spaces:read` / `spaces:write` / `spaces:delete` (`packages/core/src/permissions.ts:90`, `apps/api/src/lib/permissions.ts:132`). Owners and admins hold all three; members and viewers hold `spaces:read` only (`apps/api/src/lib/permissions.ts:193`, `:213`).

| Method               | Path                                                  | Permission         | Notes                                                      |
| -------------------- | ----------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `GET`                | `/api/spaces`                                         | `spaces:read`      | Default first, then oldest-first (`services/spaces.ts:65`) |
| `POST`               | `/api/spaces`                                         | `spaces:write`     | 403 for API keys                                           |
| `GET`                | `/api/spaces/{id}`                                    | `spaces:read`      |                                                            |
| `PATCH`              | `/api/spaces/{id}`                                    | `spaces:write`     | `name`, `settings`                                         |
| `DELETE`             | `/api/spaces/{id}`                                    | `spaces:delete`    | 400 on the default space                                   |
| `GET`/`POST`         | `/api/spaces/{id}/packages`                           | — / `spaces:write` |                                                            |
| `GET`/`PUT`/`DELETE` | `/api/spaces/{id}/packages/{scope}/{name}`            | — / `spaces:write` | model, proxy, generation config, version pin               |
| `GET`                | `/api/spaces/{id}/packages/{scope}/{name}/run-config` | `agents:read`      | Resolved per-space config + overrides + pin, in one call   |

**Wire shape.** The object discriminator is `object: "space"` (and `object: "space_package"` on the install rows). Per `docs/CASING_CONVENTIONS.md`, `spaceId` is on the universal DB-convention carve-out and stays **camelCase** on the wire, as do `id`, `isDefault` and `allowedRedirectDomains` (Carve-out 4n); the domain fields on the space-package DTO are snake_case (`version_id`, `installed_at`, `package_type`, `package_source`). The one projection the route does by hand is `created_by`: the Drizzle field is `createdBy` but `*By` is an actor reference, not a carve-out, so `toSpaceWire` renames it (`apps/api/src/routes/spaces.ts:46`).

Mutations record audit events with `resourceType: "space"` and actions `space.created` / `space.updated` / `space.deleted` (`apps/api/src/routes/spaces.ts:118`, `:165`, `:189`).

## Delete cascade

`deleteSpace` (`apps/api/src/services/spaces.ts:119`) runs the whole teardown in one transaction, in this order:

1. **Lock the organization**, then the space row, both `FOR UPDATE` (`:125`, `:133`). Org-first is the same lock order file and upload writes use; the parent lock is what stops a concurrent FK insert from being cascade-deleted without a matching deletion job.
2. **Refuse the default space** — `400 Cannot delete default space` (`:140`). An org always has one.
3. **Enumerate the owned storage** before the FK cascade removes the rows that name it: `files`, `uploads`, and every run's workspace (`:142`–`:150`), each turned into a `storage_deletion_jobs` row with reason `space_deleted` (`:154`, `:158`).
4. **Account the bytes** — the freed `files.size` sum is decremented off `organizations.files_bytes_used` synchronously, under the org lock (`:167`).
5. **Delete the row.** Postgres cascades the rest.

**Package artifacts are deliberately not enumerated** (`:160`): `packages` is org-scoped and carries no `space_id`, so this cascade drops only the `space_packages` join rows — the package objects stay owned by the org and are purged by `deleteOrganization`.

Everything else follows the FK. What each dependent does on a space delete:

| Table                                   | `space_id`    | On delete                                    |
| --------------------------------------- | ------------- | -------------------------------------------- |
| `space_packages`                        | NOT NULL      | cascade                                      |
| `runs`                                  | NOT NULL      | cascade                                      |
| `package_schedules`                     | NOT NULL      | cascade                                      |
| `package_persistence`                   | NOT NULL      | cascade                                      |
| `end_users`                             | NOT NULL      | cascade                                      |
| `api_keys`                              | NOT NULL      | cascade                                      |
| `files`                                 | NOT NULL      | cascade (+ storage job)                      |
| `uploads`                               | NOT NULL      | cascade (+ storage job)                      |
| `notifications`                         | NOT NULL      | cascade                                      |
| `integration_connections`               | NOT NULL      | cascade                                      |
| `integration_oauth_clients`             | NOT NULL      | cascade                                      |
| `integration_pins`                      | NOT NULL      | cascade                                      |
| `integration_org_defaults`              | NOT NULL      | cascade                                      |
| `space_smtp_configs`                    | NOT NULL (PK) | cascade                                      |
| `space_social_providers`                | NOT NULL      | cascade                                      |
| `webhooks`                              | nullable      | cascade                                      |
| `oauth_clients` (`referenced_space_id`) | nullable      | cascade                                      |
| `audit_events`                          | nullable      | **set null** — the record outlives the space |

Two of those columns are nullable because the row can be scoped at either level, and a CHECK ties the discriminator to the id: `webhooks` requires `(level = 'org' AND space_id IS NULL) OR (level = 'space' AND space_id IS NOT NULL)` (`packages/db/src/schema/webhooks.ts:66`), and `oauth_clients` carries the three-way `org` / `space` / `instance` version of the same rule (`packages/db/src/schema/oidc.ts:132`). `audit_events.space_id` is `ON DELETE SET NULL` on purpose (`packages/db/src/schema/audit.ts:27`) — deleting a space must not delete the record that it was deleted.

## Deploying the rename

The rename ships as **two files that are one deploy**:

- `packages/db/drizzle/0053_applications_to_spaces.sql` — the **catalog** half. Four table renames (`applications` → `spaces`, `application_packages` → `space_packages`, `application_smtp_configs` → `space_smtp_configs`, `application_social_providers` → `space_social_providers`), eighteen column renames, and every constraint, index and `notify.ts` PL/pgSQL function body that spells the retired word. `ALTER … RENAME` throughout — never drop-and-recreate, because the table holds live rows and eighteen foreign keys must survive with no window in which a constraint is absent. It rewrites **no row values**.
- `scripts/migration/0003-application-ids-to-space-ids.sql` — the **row-value** half, run by an operator in the same window (`docs/NO_TRANSITIONAL_CODE.md` §2 keeps one-off content rewrites out of drizzle). It re-mints `spaces.id` and the eighteen referencing columns from `app_…` to `spc_…`, rewrites persisted `applications:*` permission scope strings to `spaces:*`, and rewrites `user.realm` / `session.realm` (`end_user:<app_…>` → `end_user:<spc_…>`), the `'application'` → `'space'` level literals, and every storage key whose leading segment is a space id.

They are one rewrite rather than five because a space id is quoted inside `runs.input`, `runs.result`, `run_logs`, chat message payloads and `audit_events.after`, and is embedded again in the realm and in `files.storage_key`. Splitting one field of it out would make the operator's script partial and unverifiable — the exact failure mode the previous rename shipped.

**Three CHECK constraints are added `NOT VALID`** and must be promoted afterwards. A column rename carries CHECK bodies along on its own (Postgres stores them as parsed trees keyed on attnum), but a **string literal** inside the body is data and is not rewritten — so `webhooks_level_values`, `webhooks_level_check` and `oauth_clients_level_check` are dropped and re-added spelling `'space'`. At that moment the rows still say `'application'`, so a validating `ADD CONSTRAINT` would scan and fail. `NOT VALID` skips only the initial full-table verification; the constraint is enforced on every INSERT and UPDATE from the instant it exists, so the platform can write `'space'` immediately while the un-rewritten rows are tolerated until the operator's script reaches them. After the row rewrite:

```sql
ALTER TABLE "webhooks"      VALIDATE CONSTRAINT "webhooks_level_values";
ALTER TABLE "webhooks"      VALIDATE CONSTRAINT "webhooks_level_check";
ALTER TABLE "oauth_clients" VALIDATE CONSTRAINT "oauth_clients_level_check";
```

**Applying the catalog half alone is not a deploy.** The platform boots reading `app_` ids through `assertSpaceId`, which rejects them by design and says so in the 400 — which is the guard doing its job, not a bug.
