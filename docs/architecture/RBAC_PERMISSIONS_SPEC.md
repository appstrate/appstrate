# RBAC & permissions

Who may do what, where. Two layers, one vocabulary:

- **Organization roles** — a fixed, platform-defined set (`owner`, `admin`, `member`, `guest`). They govern the org itself: membership, billing, spaces as a catalog, org-wide infrastructure (models, proxies, credentials, OAuth clients). Not customizable.
- **Space roles** — a bundle of space-level permissions, assigned per `(space, user)`. Four presets ship with the platform (`admin`, `builder`, `operator`, `viewer`); an org may define its own bundles. This is where granularity lives.

A space is the **unit of access**, not just the unit of scoping. "Who can see this agent" is answered by "who is a member of its space". There is no per-resource ACL, and this document explains why (§13).

Effective permissions for a request = permissions of the caller's org role ∪ permissions of the caller's role in the current space, intersected with the credential's ceiling (API-key scopes, OIDC scopes). Every guard stays what it is today: `Set.has("resource:action")`.

> **Status.** The model below is implemented: the level split and the preset table, `guest`, `space_members` / `space_roles` / visibility, the resolver and the three pipeline keys, `requireSpaceContext`'s membership step and the `enterSpaceContext` seam, the filtered `GET /api/spaces` with per-space `permissions`, `/api/spaces/:id/members`, API keys resolving their creator's membership, invitations carrying `space_assignments`, `permissions` on the org listing, the `/api/roles` CRUD + vocabulary route behind `features.custom_roles`, the SPA (`can()`, space switcher, space-members and roles pages, org members with `guest` + assignments), space-scoped `chat_sessions`, and the `principalPermissions` module member (§4.2) with its boot validation, cached union and `invalidatePrincipalPermissions`. The **cloud half** — billing managers, billing contact, Stripe email, `getOrgAdminEmails` removed from the contract — ships in a separate PR against `@appstrate/cloud`, so no module declares the member yet and the surface is inert in OSS. The one remaining follow-up is in §12. Where this document and the code differ, the code is the authority.

Related: `SPACES.md` (space resolution on the wire), `SECURITY.md` §Layer 5 (permission guards), `docs/NO_TRANSITIONAL_CODE.md` (migration doctrine), `/docs/architecture/OSS_EE_SPEC.md` (custom roles are an EE surface).

---

## 1. Decisions

| #   | Question               | Decision                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OSS or EE?             | Org roles, space membership, visibility and the four **presets are OSS core**. **Custom roles** (creating a bundle) are gated behind `features.custom_roles`, a module-declared flag. The data model, resolver and routes live in core; only the write routes check the flag.                                                | `OSS_EE_SPEC.md` places "RBAC avancé" in cloud; Vercel and GitHub gate custom/project-level roles at Enterprise. An OSS platform must still be able to put people in spaces with sensible presets, otherwise the space layer is decorative. Flipping the decision later is deleting one check. |
| 2   | `guest` now?           | **Yes.** `guest` is an org role with no implicit space access: a guest sees exactly the spaces they were added to.                                                                                                                                                                                                           | It is what makes "org users" and "space members" two different things (Linear guest, Notion guest, Vercel contributor). Without it every member sees every open space and the space layer only nuances a role.                                                                                 |
| 3   | Default space          | Always `open`; every `member` is implicitly in it with the space's default preset. Cannot be made `closed`/`private` (DB check).                                                                                                                                                                                             | Notion's default teamspace. An org needs one place a new member lands.                                                                                                                                                                                                                         |
| 4   | Who edits custom roles | **Org owner/admin only** (`roles:write`). Space admins **assign** roles inside their space (`space-members:change-role`) but never define them. Presets are code, not rows, and are immutable.                                                                                                                               | GitHub: custom repo roles are org-level definitions applied per repo. Role definitions edited by someone who does not hold every permission is a privilege-ceiling problem; org admins already hold everything, so there is none.                                                              |
| 5   | Straddling resources   | Classified one by one in §3. Notably: packages are authored **from a space** (space-level `agents:write` etc.); `webhooks` splits into `webhooks` (space) and `org-webhooks` (org); `chat_sessions` gains a `space_id`; `integrations:install` splits off `integrations:configure` (OAuth clients + defaults, session-only). | Each straddler today is handled by an ad-hoc role check outside RBAC. Splitting the vocabulary is what lets those checks die.                                                                                                                                                                  |
| 6   | Existing `viewer` rows | Org `viewer` is **removed**. Prod rows become org `guest` + an explicit `viewer` row in every space that exists at migration time (`scripts/migration/`).                                                                                                                                                                    | Read-only-everywhere is a space concern. `guest` + explicit rows reproduces today's reach exactly and does not widen on spaces created later; mapping to `member` would silently grant the open-space default preset.                                                                          |
| 7   | Billing                | **Not an org role.** Cloud owns two concepts: **billing managers** (org users granted `billing:*` through a generic per-principal permission hook) and a **billing contact** (an email, not necessarily a user, plus CC list; set as the Stripe customer email).                                                             | Core is Apache-2.0 and carries zero billing vocabulary — a `billing` value in the `org_role` enum would break that. GitHub's billing manager is exactly "a member with extra org-level grants".                                                                                                |

Considered and rejected: §13.

---

## 2. Why authorization is hand-rolled

Better Auth provides identity only — sessions, magic link, social, the OIDC provider (`packages/db/src/auth.ts`). Its organization, admin and apiKey plugins are not used and `createAccessControl` has zero occurrences: every rule below is this codebase's own, for the reasons in §13.1.

---

## 3. The model

### 3.1 Two layers

```
Organization
├── org role per user      owner | admin | member | guest        (fixed)
├── space_roles            custom bundles of space-level permissions (org-defined)
└── Space
    ├── visibility         open | closed | private
    ├── default_role       preset applied to implicit members of an open space
    └── space role per user   preset (admin | builder | operator | viewer) or custom
```

Every permission string belongs to exactly **one level**, org or space (§3.4). An org role grants org-level strings only; a space role grants space-level strings only. The union is the caller's effective set in that space.

### 3.2 Org roles

| Role     | Org-level grants                                                                                         | Space access                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `owner`  | everything, incl. `org:delete`                                                                           | implicit `admin` in every space                                                      |
| `admin`  | everything except `org:delete`                                                                           | implicit `admin` in every space                                                      |
| `member` | `org:read`, `members:read`, `spaces:read`, `models:read`, `proxies:read`, `llm-proxy:call`, module reads | implicit `default_role` in every **open** space; explicit rows elsewhere             |
| `guest`  | `org:read`, `spaces:read`, `models:read`, `proxies:read`, `llm-proxy:call`                               | **explicit rows only** — no implicit membership anywhere, not even the default space |

Who may change whose org role stays a pure function (`packages/shared-types/src/member-role-policy.ts`): owner manages any non-owner; admin manages `member`/`guest`; nobody manages themselves; `owner` is never assignable through the API (ownership transfer is out of scope for this spec).

Rule: **`space_members` never holds an owner or admin.** Their access is implied by the org role; an explicit row is refused at write (409 `redundant_space_role`) and deleted by the service when a user is promoted to admin/owner. Demoting an admin to member drops them to implicit membership — the previous explicit rows are gone, which is the honest reading of "no longer an admin".

### 3.3 Space roles

**Presets** are constants in `apps/api/src/lib/permissions.ts`, exactly like today's org matrix — not rows. A new space-level permission joins the right preset in the same commit that adds it, with no data migration.

| Preset     | Intent             | Grants                                                                                                                                                                                                                                                           |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`    | run the space      | every space-level permission                                                                                                                                                                                                                                     |
| `builder`  | author and operate | everything except `space-settings:*`, `space-members:*`, `api-keys:*`                                                                                                                                                                                            |
| `operator` | use what is built  | today's `MEMBER` space slice: `agents:read/run`, `skills:read`, `mcp-servers:read`, `runs:read/cancel`, `files:read`, `schedules:read`, `persistence:read`, `integrations:read/connect/disconnect`, `end-users:read/write`, `chat:read/write`, `mcp:read/invoke` |
| `viewer`   | look               | the `:read` actions of `operator` (so `api-keys:read`, `space-members:read` and `webhooks:read` are **not** viewer's — they are `admin`'s, as today)                                                                                                             |

**Custom roles** are rows in `space_roles` (§5): an org-scoped `key`, a display name, and `permissions text[]` validated at write against the loaded space-level vocabulary (core + modules that declared `level: "space"`). A string the validator does not know is a 400 naming it — same posture as `validateScopes` for API keys. A permission that becomes unknown later (module unloaded) is ignored at resolve time; `Set.has` never sees it.

Custom roles cannot hold org-level strings. There is no "space-level custom role that also manages members of the org".

### 3.4 Permission vocabulary by level

Org-level (granted by org roles; resource rows live at the org):

| Resource                                          | Actions                                   | Notes                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org`                                             | `read`, `update`, `settings`, `delete`    | `update` = name/slug, **owner only** (today `PUT /api/orgs/:id` is owner-only, `organizations.ts:270`). `settings` = `PUT /api/orgs/:id/settings`, owner+admin. New action `settings` — today both hide behind `requireOrgRole`.                                        |
| `members`                                         | `read`, `invite`, `remove`, `change-role` | Finally enforced by guards; the who-manages-whom policy stays the second layer.                                                                                                                                                                                         |
| `roles`                                           | `read`, `write`, `delete`                 | **New.** Custom space-role definitions. `read` is held by every org role except `guest` — a space `admin` who is only an org `member` assigns roles and must see what is assignable. `write`/`delete` are owner/admin and additionally require `features.custom_roles`. |
| `spaces`                                          | `read`, `write`, `delete`                 | `read` = list (filtered, §6.3). `write` = create. Per-space edits move to `space-settings`.                                                                                                                                                                             |
| `models`, `proxies`, `model-provider-credentials` | as today                                  | org-wide infrastructure                                                                                                                                                                                                                                                 |
| `api-keys`                                        | —                                         | **moves to space level** (keys are space-bound, `api_keys.space_id NOT NULL`)                                                                                                                                                                                           |
| `llm-proxy`                                       | `call`                                    | `/api/llm-proxy` is not space-scoped; metered per org. Granted to member and guest.                                                                                                                                                                                     |
| `oauth-clients`, `cli-sessions` (oidc)            | as today                                  | owner/admin. `oauth_client.space_id` nullable stays an implementation detail of the oidc module; the permission is org-level.                                                                                                                                           |
| `org-webhooks` (webhooks)                         | `read`, `write`, `delete`                 | **New** — the `level = "org"` half of today's `webhooks`.                                                                                                                                                                                                               |
| `billing` (cloud)                                 | `read`, `manage`                          | §10                                                                                                                                                                                                                                                                     |

Space-level (granted by space roles; resource rows carry `space_id`):

| Resource                | Actions                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space-settings`        | `write`                                                                                 | **New.** `PATCH /api/spaces/:id` (name, settings, visibility, default role). Preset `admin` only.                                                                                                                                                                                                                                                                                                                                |
| `space-members`         | `read`, `invite`, `remove`, `change-role`                                               | **New.** Preset `admin` only.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `agents`                | `read`, `write`, `configure`, `delete`, `run`                                           | Authoring happens from a space; the package row is org-scoped but reachable only through `space_packages`. `configure` also gates INSTALL/config/uninstall of an agent in a space (`POST`/`PUT`/`DELETE /api/spaces/:spaceId/packages`) — installing decides which space runs an agent, it does not author one. Deleting a package installed in another space stays whatever the service does today — not a permission question. |
| `skills`, `mcp-servers` | `read`, `write`, `delete`                                                               | same; `write` is also the space-install permission for those types                                                                                                                                                                                                                                                                                                                                                               |
| `integrations`          | `read`, `write`, `delete`, `install`, `uninstall`, `configure`, `connect`, `disconnect` | **New `configure`** = OAuth clients + per-space defaults (`integrations.ts:1037-1178`). Session-only, never API-key-grantable — this is what retires `assertOrgAdmin`. `install`/`uninstall` are also the space-install permissions for this type.                                                                                                                                                                               |
| `runs`                  | `read`, `cancel`, `delete`                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `files`                 | `read`, `delete`                                                                        | per-file container ACL unchanged                                                                                                                                                                                                                                                                                                                                                                                                 |
| `schedules`             | `read`, `write`, `delete`                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `persistence`           | `read`, `delete`                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `end-users`             | `read`, `write`, `delete`                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `api-keys`              | `read`, `create`, `revoke`                                                              | preset `admin` only. A key delegates its creator's effective set in that space (§7.1).                                                                                                                                                                                                                                                                                                                                           |
| `credential-proxy`      | `call`                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `webhooks` (webhooks)   | `read`, `write`, `delete`                                                               | the `level = "space"` half                                                                                                                                                                                                                                                                                                                                                                                                       |
| `chat` (module-chat)    | `read`, `write`                                                                         | requires `chat_sessions.space_id` (§5)                                                                                                                                                                                                                                                                                                                                                                                           |
| `mcp` (mcp)             | `read`, `invoke`                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The level is declared once, in core, next to the resource: `CORE_RESOURCE_LEVELS: Record<CoreResource, "org" | "space">`, and a unit test asserts every `CoreResource` has one. `SPACE_LEVEL_PERMISSIONS` / `ORG_LEVEL_PERMISSIONS` derive from it and are what the custom-role validator and the preset typing use — a preset that lists an org-level string is a TypeScript error.

### 3.5 Module contract

`ModulePermissionContribution` (`packages/core/src/module.ts:352`) changes shape. The old `grantTo: OrgRole[]` alone cannot express a space-level grant.

```ts
type ModulePermissionContribution = {
  resource: R;
  actions: readonly Action[];
  level: "org" | "space";
  /** level: "org" — org roles that hold every listed action. */
  grantTo?: ReadonlyArray<OrgRole>;
  /** level: "space" — presets that hold every listed action. */
  presets?: ReadonlyArray<SpaceRolePreset>;
  apiKeyGrantable?: boolean;
  endUserGrantable?: boolean;
};
```

`level: "org"` requires `grantTo` and forbids `presets`; `level: "space"` the reverse (a discriminated union, enforced at boot too). All five contributing modules are updated in the same PR — there is no default level and no compatibility reading of a `grantTo` on a space-level entry (`NO_TRANSITIONAL_CODE.md` §1).

A second, new module surface — `principalPermissions` — is the generic mechanism a module uses to grant **org-level** strings to a specific user rather than to a role. Cloud uses it for billing managers (§10). Signature and caching in §4.2.

---

## 4. Enforcement

### 4.1 Resolver

```ts
type SpaceRoleRef = { preset: SpaceRolePreset } | { custom: SpaceRoleRow };

function resolveSpaceRole(orgRole, space, memberRow): SpaceRoleRef | null {
  if (orgRole === "owner" || orgRole === "admin") return { preset: "admin" };
  if (memberRow) return memberRow.ref;                    // explicit wins over implicit
  if (orgRole === "member" && space.visibility === "open") return { preset: space.defaultRole };
  return null;                                            // guest, or closed/private without a row
}

effective(space) = ceiling( orgPermissions ∪ spacePermissions(resolveSpaceRole(...)) )
```

`orgPermissions = ORG_ROLE_PERMISSIONS[orgRole] ∪ module org-level grants ∪ principalPermissions(user, org)`.
`ceiling(S) = scopeCeiling ? S ∩ scopeCeiling : S` — the API-key scope list or the OIDC scope claim; absent for cookie sessions.

`null` on a space-scoped route is a **403 `not_a_space_member`** for `open`/`closed` spaces and a **404** for `private` ones (the space does not exist for that caller; same reasoning as `getPackageWithAccess` returning `null` for "not reachable").

### 4.2 Pipeline

Three context keys replace today's single write of `permissions`:

| Key              | Set by                                      | Value                                                                                                       |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `orgPermissions` | auth pipeline, once org role is known       | org-level effective set                                                                                     |
| `scopeCeiling`   | auth pipeline                               | API-key `scopes`, OIDC scope claim; `undefined` for sessions                                                |
| `permissions`    | auth pipeline **and** `requireSpaceContext` | `ceiling(orgPermissions)` at first; `ceiling(orgPermissions ∪ spacePermissions)` once the space is resolved |

`makePermissionGuard` keeps reading `permissions` and nothing else. A route outside `SPACE_SCOPED_PREFIXES` sees org-level permissions only; a space-level string can therefore never be satisfied on an org route, which is the property we want (a `builder` cannot `agents:write` through a non-space path, because there is none).

`requireSpaceContext` gains the membership step after `validateSpaceInOrg`: load the `space_members` row for `(spaceId, userId)` (one indexed PK lookup), run the resolver, write `permissions`, set `c.set("spaceRole", ref)`. For API-key callers the pinned space goes through the same step — the key's **creator** is the user whose membership is resolved (§7.1).

`principalPermissions` _(implemented)_ is a module member, not a hook — every module that declares it contributes and the answers are unioned, which is neither dispatch mode `ModuleHooks` offers:

```ts
principalPermissions?: {
  mayGrant: readonly string[];
  resolve(ctx: { orgId: string; userId: string }): Promise<readonly string[]>;
};
```

It is awaited once per request in the pipeline, for session callers and for `deferOrgResolution` strategies (which behave like sessions) only. It is not evaluated for API keys or end-user tokens: a module may only declare session-only strings in `mayGrant` (never `apiKeyGrantable` / `endUserGrantable` ones), so those ceilings could not contain the result anyway. Each module's answer is filtered to its own `mayGrant` — an undeclared string is dropped and logged, never granted — and a throwing resolver is isolated (logged, contributing nothing), because a billing outage must not lock every admin out of the org. Results are cached with the `@appstrate/core/cache` primitive under `(orgId, userId)`, TTL 10s, and invalidated through the pg_notify bus by the module's own writes calling the core-exported `invalidatePrincipalPermissions(orgId, userId?)` — a module that contributes this member owns its invalidation, the same way cloud owns its billing cursor. `mayGrant` is validated at boot against `ORG_LEVEL_PERMISSIONS` ∪ the loaded modules' `level: "org"` contributions, minus everything API-key- or end-user-grantable; a violation is a boot error naming the module and the string. With no module declaring the member the pipeline never reads the cache at all.

The same union is what `GET /api/orgs` and `GET /api/me/orgs` expose in their `permissions` field, through one helper (`listedOrgPermissionsForCaller`, `apps/api/src/lib/principal-permissions.ts`), so the two listings cannot answer differently for the same caller.

The `/api/orgs/:orgId*` family is exempt from `requireOrgContext` (the org is in the path, not in `X-Org-Id`), so the pipeline's permission step never runs for it. **One middleware** stands in — `orgPathContext` (`apps/api/src/middleware/org-path-context.ts`), mounted at the app root ahead of the orgs router AND of every module router, preceded by `apiKeyOrgScopeGuard` for the cross-org pin. It derives from the membership row for session and `deferOrgResolution` callers only, applies `scopeCeiling`, and unions the same principal grants; every other credential keeps the ceiling-limited set the pipeline already wrote. A module mounting under `/api/orgs/:orgId/…` (oidc's `cli-sessions`) inherits it and derives nothing: a second derivation there wrote `permissions` from the membership row unconditionally, which let an API key scoped to `runs:read` reach those routes with its creator's full org authority.

### 4.3 Guards

`makePermissionGuard(required)` and its three façades. Audit on denial, once. There is no `requireAdmin()`, no `requireOwner()` and no `requireOrgRole()`: the only shape is `requirePermission(resource, action)`. The `who-manages-whom` policy runs **inside** the handler after the guard.

Modules keep gating their own routes with `requireModulePermission`. A module that mounts a space-level resource on a route family outside `SPACE_SCOPED_PREFIXES` must resolve the space itself (webhooks already does, from an explicit `spaceId` field) and call the same exported `applySpacePermissions(c, space)` helper so that `permissions` carries the space slice — otherwise its guard can never pass for a non-admin, which is fail-closed and therefore the right default.

---

## 5. Data model

```sql
-- enums.ts
org_role: owner | admin | member | guest

-- spaces
ALTER TABLE spaces
  ADD COLUMN visibility   text NOT NULL DEFAULT 'open'
    CHECK (visibility IN ('open', 'closed', 'private')),
  ADD COLUMN default_role text NOT NULL DEFAULT 'operator'
    CHECK (default_role IN ('admin', 'builder', 'operator', 'viewer')),
  ADD CONSTRAINT spaces_default_is_open CHECK (NOT is_default OR visibility = 'open');

-- custom role definitions (org-scoped)
CREATE TABLE space_roles (
  id          text PRIMARY KEY,                       -- srl_ + uuid, shape-guarded like spc_
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         text NOT NULL,                          -- slug, unique per org, never a preset name
  name        text NOT NULL,
  description text,
  permissions text[] NOT NULL,                        -- validated ⊆ SPACE_LEVEL_PERMISSIONS at write
  created_by  text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key),
  CHECK (key NOT IN ('admin', 'builder', 'operator', 'viewer'))
);
CREATE INDEX idx_space_roles_created_by ON space_roles(created_by);   -- referencing side of SET NULL

-- explicit membership
CREATE TABLE space_members (
  space_id       text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_role    text CHECK (preset_role IN ('admin', 'builder', 'operator', 'viewer')),
  custom_role_id text REFERENCES space_roles(id) ON DELETE RESTRICT,
  added_by       text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id),
  CHECK (num_nonnulls(preset_role, custom_role_id) = 1)
);
CREATE INDEX idx_space_members_user_id        ON space_members(user_id);
CREATE INDEX idx_space_members_custom_role_id ON space_members(custom_role_id);
CREATE INDEX idx_space_members_added_by       ON space_members(added_by);

-- invitations carry the space assignments applied on accept
ALTER TABLE org_invitations
  ADD COLUMN space_assignments jsonb NOT NULL DEFAULT '[]';
  -- [{ "space_id": "spc_…", "preset_role": "builder" } | { "space_id": "spc_…", "custom_role_id": "srl_…" }]
  -- validated by zod at invite time; a guest invitation with an empty list is a 400.

-- chat sessions become space-scoped
ALTER TABLE chat_sessions ADD COLUMN space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX idx_chat_sessions_space_user ON chat_sessions(space_id, user_id);
```

Design notes:

- **Presets are not rows** so the preset-or-custom choice is two nullable columns with a `num_nonnulls` check rather than one column mixing a key and an id. Both halves are DB-enforced: presets by CHECK, customs by FK.
- **`ON DELETE RESTRICT` on `custom_role_id`**: deleting a role still assigned is a 409 naming the count. Reassign first. (GitHub silently drops access on delete; a loud refusal is more in keeping with this codebase.)
- **`default_role` is a preset only.** A custom default for open spaces is YAGNI; it would need a second nullable column and a third check for one setting nobody asked for.
- **Space delete cascade** (`SPACES.md` §Delete cascade) gains `space_members` for free through the FK; nothing to add to `deleteSpace`.
- **Org delete** cascades `space_roles` via `org_id`.
- `visibility` is a `text` with a CHECK, not a pg enum — same choice as `webhooks.level`; adding a value is a migration either way and text spares the enum-rewrite dance.

---

## 6. HTTP surface

Casing per `docs/CASING_CONVENTIONS.md`: snake_case on the wire, `id`/`*Id` carve-outs as today.

### 6.1 Org users — `/api/orgs/:orgId/members` _(existing, re-guarded)_

Guards become `requirePermission("members", …)`; the assignable-role policy keeps running in the handler. `role` accepts `admin | member | guest`. Invite body gains `space_assignments`.

### 6.2 Roles — `/api/roles` _(new, org-scoped)_

| Method   | Path                    | Permission                              | Notes                                                                                                                                                                            |
| -------- | ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/roles`            | `roles:read`                            | presets (`kind: "preset"`, read-only, with their permission list) + custom rows (`kind: "custom"`)                                                                               |
| `POST`   | `/api/roles`            | `roles:write` + `features.custom_roles` | `{ key, name, description?, permissions[] }` → 201                                                                                                                               |
| `PATCH`  | `/api/roles/:id`        | `roles:write` + flag                    | name/description/permissions                                                                                                                                                     |
| `DELETE` | `/api/roles/:id`        | `roles:delete` + flag                   | 409 `role_in_use` with `{ member_count }`                                                                                                                                        |
| `GET`    | `/api/roles/vocabulary` | `roles:read`                            | the space-level strings a custom role may hold, grouped by resource, with the level and API-key/end-user grantability — the same shape `GET /api/api-keys/available-scopes` uses |

Without the flag the three write routes answer 403 `feature_unavailable`. Object discriminator: `object: "role"`. Audit: `role.created` / `role.updated` / `role.deleted`.

### 6.3 Spaces — `/api/spaces` _(existing, extended)_

`GET /api/spaces` filters by caller:

| Caller        | Sees                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| owner / admin | all spaces                                                                                                      |
| member        | `open` (implicit) + `closed` (listed, `access: "none"`, cannot enter) + `private` **only** with an explicit row |
| guest         | explicit rows only                                                                                              |
| API key       | its own space only (unchanged)                                                                                  |

Each item gains `visibility`, `default_role`, `access: "member" | "none"`, `role` (`{ kind, key, name }` or `null`) and `permissions: string[]` — the caller's effective set in that space, already ceiling-applied. The SPA reads nothing else to decide what to render (§8).

`PATCH /api/spaces/:id` moves from `spaces:write` to `space-settings:write` and accepts `visibility` and `default_role`. Setting `visibility` to anything but `open` on the default space is a 400 (the DB check backs it). `POST` stays `spaces:write`; the creator is **not** given a row — they are an admin already, or they could not create.

### 6.4 Space members — `/api/spaces/:id/members` _(new)_

| Method   | Path                              | Permission                  | Notes                                                                                                                                                                                                                                                    |
| -------- | --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/spaces/:id/members`         | `space-members:read`        | explicit rows always; the IMPLICIT ones (`source: "org_role" \| "open_space"`) are the org directory seen through a space and need `members:read` too, so a guest holding preset `admin` here manages what the space granted and enumerates nothing else |
| `POST`   | `/api/spaces/:id/members`         | `space-members:invite`      | `{ userId, preset_role }` or `{ userId, custom_role_id }` (`userId` per the `*Id` carve-out); user must be an org member; 409 for owner/admin                                                                                                            |
| `PATCH`  | `/api/spaces/:id/members/:userId` | `space-members:change-role` |                                                                                                                                                                                                                                                          |
| `DELETE` | `/api/spaces/:id/members/:userId` | `space-members:remove`      | removing a `member` from an open space leaves them implicit — the route says so in the response (`access_after: "implicit" \| "none"`)                                                                                                                   |

Audit: `space.member_added` / `space.member_role_changed` / `space.member_removed`.

Inviting someone who is not yet in the org goes through `POST /api/orgs/:orgId/members` with `space_assignments`; the space page offers that path when the email is unknown.

### 6.5 Org list — `GET /api/orgs`

Each item gains `permissions: string[]` (org-level effective set, principal grants included). `role` stays for display.

### 6.6 OpenAPI

Every new route in `apps/api/src/openapi/paths/`, 403 documented on every guarded route (the static analyzer in `scripts/verify-openapi.ts:1963` enforces it), `bun run openapi:baseline` regenerated, `detect:breaking` will flag `viewer` leaving the role enum and `PATCH /api/spaces/:id` changing its permission — both intended.

---

## 7. Credentials other than a cookie

### 7.1 API keys

`permissions = scopes ∩ the creator's effective set in the key's space`.

- Mint: `validateScopes(scopes, creatorEffective)` where `creatorEffective` is the creator's effective set in the key's space. Non-grantable → 400; beyond the creator → filtered. Unchanged in kind.
- Request: the pipeline pins `spaceId` from the key row; `requireSpaceContext` resolves the **creator's** membership in that space and applies the ceiling `scopes`. A creator who lost the space (removed, demoted to guest without a row) leaves the key with `scopes ∩ orgPermissions` — nearly nothing, and the key 403s in that space. That is the live-ceiling semantics this design chose; no revocation sweep.
- `api-keys:*` is a space-level permission held by preset `admin`. A `builder` cannot mint keys.
- `integrations:configure` is never API-key-grantable: the property "a key cannot do this even if its creator can" is expressed in the vocabulary, not in a role check.
- Org-administration routes refuse API keys outright, expressed as `org:*` / `members:*` / `roles:*` being non-grantable rather than as an `authMethod === "api_key"` branch.

### 7.2 OIDC tokens (oidc module)

- `dashboard_user` tokens: ceiling = scope claim; org slice from the subject's org role; space slice resolved per request from the subject's membership in the pinned/header space. Same path as a session with a `scopeCeiling`.
- `end_user` tokens: **unchanged**. The fixed 10-permission allowlist (`apps/api/src/modules/oidc/auth/scopes.ts:42`) plus `endUserGrantable` module entries, single space, own rows only (`apps/api/src/lib/actor.ts`). End-users are not space members and never appear in `space_members`.

### 7.3 MCP (mcp module)

A per-org MCP bearer re-enters space-scoped routes in-process and lands on the default space (`SPACES.md` §Resolving). With this spec that re-entry resolves the token subject's role in the default space — every `member` is implicit there; a `guest` without a row gets 403, which is correct.

---

## 8. SPA

`usePermissions()` is rewritten, not extended:

```ts
const { can, orgRole, spaceRole } = usePermissions();
can("agents:write"); // current space's `permissions` ∪ current org's `permissions`
```

There are no `isOwner` / `isAdmin` / `isMember` helpers: every gate is a `can(...)` on the permission the server actually checks for that action. The org-settings layout hides a tab when the caller holds none of the tab's permissions; the space switcher lists only `access: "member"` spaces (`closed` ones appear disabled with a "request access" hint, `private` ones do not appear); `RunAgentButton` renders on `agents:run`.

Pages: **Org settings → Roles** (presets read-only, custom CRUD when `features.custom_roles`, a permission picker driven by `GET /api/roles/vocabulary`); **Space settings → Members** (§6.4, with the implicit/explicit source column); **Org settings → Members** gains `guest` and the per-invite space assignment.

The SPA's role strings are display only. `packages/shared-types/src/member-role-policy.ts` keeps the assignable-role logic for the org tab. `ASSIGNABLE_ORG_ROLES = ["guest", "member", "admin"]`.

`features` reaches the SPA as it does for `billing` (`apps/web/src/components/sidebar-billing.tsx`).

---

## 9. OSS / EE boundary

|                                                                    | OSS (Apache-2.0, core)  | Provided by a module                                                                         |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| org roles, `guest`                                                 | ✅                      |                                                                                              |
| `space_members`, visibility, presets, resolver, routes             | ✅                      |                                                                                              |
| `space_roles` table, validator, `GET /api/roles`, vocabulary route | ✅                      |                                                                                              |
| `POST/PATCH/DELETE /api/roles`                                     | code in core, **gated** | `features.custom_roles: true` — cloud today; a future self-hosted EE license module tomorrow |
| billing managers, billing contact, `billing:*`                     |                         | cloud (§10)                                                                                  |
| `principalPermissions` hook                                        | contract in core        | any module                                                                                   |

Core keeps its zero-billing-vocabulary invariant: no `billing` role, no billing column, no billing route.

---

## 10. Billing (cloud module)

Two concepts, deliberately separate:

**Billing managers** — org users who may act on billing without being admins. Cloud table `cloud_billing_managers(org_id, user_id, added_by, created_at)`, managed at `PATCH /api/billing/managers` (`billing:manage`), listed in the billing page. Cloud grants them `billing:read` + `billing:manage` through `principalPermissions` (§4.2) with `mayGrant: ["billing:read", "billing:manage"]`. Role grants stay: `billing:read` → owner/admin/member (a guest does not see the plan), `billing:manage` → owner/admin. GitHub's billing manager, without the enum.

**Billing contact** — where invoices, receipts and payment alerts go.

```sql
ALTER TABLE cloud_billing_accounts
  ADD COLUMN billing_email text,                       -- NULL = fall back (below)
  ADD COLUMN billing_cc    text[] NOT NULL DEFAULT '{}';
```

- `PATCH /api/billing/contact` (`billing:manage`) sets both; each address validated; CC capped at 5.
- Stripe: `customers.create({ email: contact, metadata })` at checkout (today `email` is never set, `cloud/src/stripe/checkout.ts:28`), and `customers.update` when the contact changes. Stripe then addresses its own receipts correctly; the Dashboard-only "additional recipients" feature is not relied on.
- `sendBillingEmail` recipients = `billing_email ?? emails of org owners` ∪ `billing_cc` ∪ emails of billing managers. `getOrgAdminEmails` (fan-out to every admin) is deleted from the module contract, not kept as a fallback.
- Default at org creation: `billing_email = creator's email` — written by `onOrgCreate`, which already receives `userEmail` (`cloud/src/onboarding/post-signup.ts:77`).

Cloud's `permissionsContribution` entries gain `level: "org"` (§3.5). Cloud pins `@appstrate/core` to the major that ships the new contract; per the release rules in the root `CLAUDE.md`, core is tagged first and cloud bumped right after.

---

## 11. Migration

Doctrine: `NO_TRANSITIONAL_CODE.md`. Catalog changes are drizzle migrations; row rewrites are `scripts/migration/`.

**Schema — `packages/db/drizzle/0056_space_roles.sql`:** `ALTER TYPE org_role ADD VALUE 'guest'`; `space_roles`, `space_members`; `spaces.visibility`/`default_role` + checks; `org_invitations.space_assignments`; `chat_sessions.space_id`. Two writes ride along, each licensed by a constraint the same file promotes on the same table (§2 of the doctrine):

- `chat_sessions.space_id` is backfilled to the org's default space, then `SET NOT NULL`.
- `oauth_clients.signup_role = 'viewer'` is rewritten to `'guest'`, then `oauth_clients_signup_role_check` is re-added narrowed to `admin | member | guest`.

**Rows — `scripts/migration/0008-org-viewer-to-guest.sql`**, one transaction:

1. `INSERT INTO space_members (space_id, user_id, preset_role) SELECT s.id, m.user_id, 'viewer' FROM org_members m JOIN spaces s ON s.org_id = m.org_id WHERE m.role = 'viewer'`
2. `UPDATE org_members SET role = 'guest' WHERE role = 'viewer'`
3. `UPDATE org_invitations SET role = 'guest' WHERE role = 'viewer' AND status = 'pending'` — a pending viewer invite lands as a guest with no space; the inviter re-adds them (there is no faithful mapping, and the audit log names the inviter)
4. Verification that **discriminates**: the counts of `org_members.role = 'viewer'` and of pending `viewer` invitations must both be 0 **and** every pre-flip (user, space) pair must be covered by a `space_members` row — printed before and after, and raised on rather than returned.

Between `0056` and `0008` a member whose row still reads `viewer` has no permission set and its requests fail; run both in one maintenance window.

The `org_role` type keeps `viewer` because `ALTER TYPE … DROP VALUE` does not exist — see §12.

The drizzle snapshot is rebuilt by hand and checked against the pre-conflict one (`drizzle-migration-index-collision`).

### Deploying

`0056` and `0008` are **two files that are one deploy**, in this order:

1. **Rehearse on a replica.** Restore a `pg_dump` copy, apply `0056`, run `0008`, and read the counts it prints. Before applying, `SELECT DISTINCT c.org_id FROM chat_sessions c WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_id = c.org_id)` must return no row: an org with sessions and no space cannot be folded and fails `0056`'s `SET NOT NULL`. `0008` ships with its rows UNMEASURED; the rehearsal is what produces the numbers, and it is also what tells you how long the two steps take against real volume.
2. **Stop the application**, then apply the schema half alone. `0056` runs at boot with the rest of the pending drizzle migrations — count what is actually pending from the journal, not from the last merged PR.
3. **Run `scripts/migration/0008-org-viewer-to-guest.sql` immediately after**, before bringing the new version `up`. One transaction, idempotent, fenced; it aborts rather than committing a half-rewrite.
4. **Verify.** `0008` raises rather than returns: zero `org_members.role = 'viewer'`, zero pending `viewer` invitations, and every former (user, space) pair covered by a `space_members` row. A commit means all three held.
5. **Bring the application `up`.** Rollback is one-way from `0056` on: the previous build inserts `chat_sessions` without `space_id`, which is now NOT NULL.

The two file headers are the authority on what each step touches and what it deliberately leaves alone. Read them there, not here.

---

## 12. Follow-ups

One item remains:

- `0057_drop_org_viewer.sql` recreates `org_role` without `viewer`, which `ALTER TYPE … DROP VALUE` cannot do. It guards first — `DO $$ BEGIN IF EXISTS (SELECT 1 FROM org_members WHERE role = 'viewer') THEN RAISE EXCEPTION 'run scripts/migration/0008-org-viewer-to-guest.sql first'; END IF; END $$;` — so a database whose rows have not moved fails the deploy instead of losing them.

---

## 13. Considered and rejected

### 13.1 Better Auth `organization` plugin (dynamic access control + teams)

It has runtime roles (`organizationRole` table, `createRole`, comma-separated roles on `member.role`) and teams (`team`, `teamMember`). Rejected: teams carry **no per-team role or permission** — `hasPermission` is org-level and ignores the active team — so the one thing this spec needs is the one thing the plugin does not do. Adopting it would also replace `org_members`/`org_invitations` and the hand-rolled API keys for no gain. Better Auth stays the identity provider.

### 13.2 Scope + resource selection ("`agents:read` on these three agents")

Per-resource ACL is ReBAC territory (Zanzibar / OpenFGA / WorkOS FGA): a tuple store, a check API, list-filtering in every query, and a UI to share each thing. Notion does this at page level and it is most of Notion. Rejected for now; the model here keeps that door open in one specific way — `effective(space)` is computed per request from a resolver, so a later per-resource layer would be a second predicate in the same place, not a rewrite.

The real cost of "space = access unit" is that hiding one agent means a new space, and `integration_connections` are per space, so splitting a space duplicates connections. If that bites, the cheap next step is a `visibility: "private"` flag on a package (creator-only, filtered in SQL like `actorScopeFilter` filters runs), not an ACL.

### 13.3 Presets as seeded rows per org

One list for the UI and an FK for everything. Rejected: every new space-level permission would need a `scripts/migration/` rewrite of N×orgs rows to reach the right preset, where a constant reaches it in the same commit. The two-column `space_members` shape keeps DB enforcement for both kinds.

### 13.4 Keeping an org-level `viewer`

Vercel keeps a free team-level Viewer. Rejected: with space roles, "read everything" is `member` + a `viewer` default on open spaces, and "read only these" is `guest` + `viewer` rows. A fifth org role would exist to save an admin one setting.

### 13.5 `billing` as an org role

The obvious SOTA shape (Vercel, GitHub). Rejected on the Apache-2.0 boundary: the `org_role` enum is core, and a `billing` value there is billing vocabulary in OSS. `principalPermissions` gives cloud the same outcome and is reusable — SSO group → permission mapping is the next thing that will want it.

### 13.6 Space-level custom roles editable by space admins

Notion lets teamspace owners set defaults; nobody lets a sub-container admin define permission bundles. A definer who does not hold every permission needs a ceiling check on every edit; org admins hold everything, so restricting definition to them removes the problem instead of solving it.
