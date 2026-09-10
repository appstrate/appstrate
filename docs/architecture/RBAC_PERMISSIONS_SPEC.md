# RBAC & permissions

Who may do what, where. Two layers, one vocabulary:

- **Organization roles** — a fixed, platform-defined set (`owner`, `admin`, `member`, `guest`). They govern the org itself: membership, billing, spaces as a catalog, org-wide infrastructure (models, proxies, credentials, OAuth clients). Not customizable.
- **Space roles** — a bundle of space-level permissions, assigned per `(space, user)`. Four presets ship with the platform (`admin`, `builder`, `operator`, `viewer`); an org may define its own bundles. This is where granularity lives.

A space is the **unit of access**, not just the unit of scoping. "Who can see this agent" is answered by "who is a member of its space". There is no per-resource ACL, and this document explains why (§13).

Effective permissions for a request = permissions of the caller's org role ∪ permissions of the caller's role in the current space, intersected with the credential's ceiling (API-key scopes, OIDC scopes). Every guard is one `Set.has("resource:action")`.

> **Scope.** Everything below describes this repository. The **EE half** of §10 — billing managers, the billing contact and the Stripe customer email — lives in `packages/module-ee`, source-available under `packages/module-ee/LICENSE` and loaded only when `MODULES` names `@appstrate/module-ee`. A build that does not load it has no module declaring `principalPermissions`, and that surface resolves to nothing. Open items are in §12.

**Product terminology** (English / French):

| Term                                     | Meaning                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Users / Utilisateurs**                 | Everyone belonging to an organization, including guests, regardless of their organization role.                             |
| **Members / Membres**                    | Users who have access to a space, through either an explicit assignment or implicit membership.                             |
| **Standard user / Utilisateur standard** | The display label for the organization role `member`. This is one organization role, not the collective name for its users. |

Technical identifiers stay unchanged: `member`, `org_members`, `space_members`, `members:*` and existing API paths retain their current meaning. An implicit space member is still a member even without a `space_members` row.

Related: `SPACES.md` (space resolution on the wire), `SECURITY.md` §Layer 5 (permission guards), `docs/NO_TRANSITIONAL_CODE.md` (migration doctrine), `/docs/architecture/OSS_EE_SPEC.md` (custom roles are an EE surface).

---

## 1. Decisions

| #   | Question               | Decision                                                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OSS or EE?             | Org roles, space membership, visibility and the four **presets are OSS core**. **Custom roles** (creating a bundle) are gated behind `features.custom_roles`, a module-declared flag. The data model, resolver and routes live in core; only the write routes check the flag.                                                        | `OSS_EE_SPEC.md` places "RBAC avancé" in EE; Vercel and GitHub gate custom/project-level roles at Enterprise. An OSS platform must still be able to put people in spaces with sensible presets, otherwise the space layer is decorative. Flipping the decision later is deleting one check. |
| 2   | `guest` now?           | **Yes.** `guest` is an org role with no implicit space access: a guest sees exactly the spaces they were added to.                                                                                                                                                                                                                   | It is what makes "org users" and "space members" two different things (Linear guest, Notion guest, Vercel contributor). Without it every member sees every open space and the space layer only nuances a role.                                                                              |
| 3   | Default space          | Always `open`; every `member` is implicitly in it with the space's default preset. Cannot be made `closed`/`private` (DB check).                                                                                                                                                                                                     | Notion's default teamspace. An org needs one place a new member lands.                                                                                                                                                                                                                      |
| 4   | Who edits custom roles | **Org owner/admin only** (`roles:write`). Space admins **assign** roles inside their space (`space-members:change-role`) within their effective permission ceiling, but never define them. Presets are code, not rows, and are immutable.                                                                                            | GitHub: custom repo roles are org-level definitions applied per repo. Role definitions edited by someone who does not hold every permission is a privilege-ceiling problem; org admins already hold everything, so there is none.                                                           |
| 5   | Straddling resources   | Classified one by one in §3. Notably: packages are authored **from a space** (space-level `agents:write` etc.); `webhooks` splits into `webhooks` (space) and `org-webhooks` (org); `chat_sessions` carries a `space_id`; `integrations:configure` (OAuth clients + defaults, session-only) is separate from `integrations:install`. | A straddler that keeps one name across both levels can only be gated by an ad-hoc role check outside RBAC. Splitting the vocabulary is what puts each half behind an ordinary guard.                                                                                                        |
| 6   | Existing `viewer` rows | Org `viewer` is **removed**. Prod rows become org `guest` + an explicit `viewer` row in every space that exists at migration time (`scripts/migration/`).                                                                                                                                                                            | Read-only-everywhere is a space concern. `guest` + explicit rows reproduces the reach those rows had exactly and does not widen on spaces created later; mapping to `member` would silently grant the open-space default preset.                                                            |
| 7   | Billing                | **Not an org role.** `@appstrate/module-ee` owns two concepts: **billing managers** (org users granted `billing:*` through a generic per-principal permission hook) and a **billing contact** (an email, not necessarily a user, plus CC list; set as the Stripe customer email).                                                    | Core is Apache-2.0 and carries zero billing vocabulary — a `billing` value in the `org_role` enum would break that. GitHub's billing manager is exactly "a member with extra org-level grants".                                                                                             |

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

| Role     | Org-level grants                                                                                                       | Space access                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `owner`  | everything, incl. `org:delete`                                                                                         | implicit `admin` in every space                                                      |
| `admin`  | everything except `org:delete` and `org:update`                                                                        | implicit `admin` in every space                                                      |
| `member` | `org:read`, `members:read`, `roles:read`, `spaces:read`, `models:read`, `proxies:read`, `llm-proxy:call`, module reads | implicit `default_role` in every **open** space; explicit rows elsewhere             |
| `guest`  | `org:read`, `spaces:read`, `models:read`, `proxies:read`, `llm-proxy:call`                                             | **explicit rows only** — no implicit membership anywhere, not even the default space |

Who may change whose org role stays a pure function (`packages/shared-types/src/member-role-policy.ts`): owner manages any non-owner; admin manages `member`/`guest`; nobody manages themselves; `owner` is never assignable through the API (ownership transfer is out of scope for this spec).

Rule: **`space_members` never holds an owner or admin.** Their access is implied by the org role; an explicit row is refused at write (409 `redundant_space_role`) and deleted by the service when a user is promoted to admin/owner. That promotion records the deleted rows as `revoked_space_assignments` in the `org.member_role_updated` audit `before`, because the rows themselves are gone and a later demotion does not restore them: demoting an admin to member drops them to implicit membership, which is the honest reading of "no longer an admin".

### 3.3 Space roles

**Presets** are constants in `apps/api/src/lib/permissions.ts`, like the org matrix beside them — not rows. A new space-level permission joins the right preset in the same commit that adds it, with no data migration.

| Preset     | Intent                               | Grants                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`    | run the space                        | every space-level permission                                                                                                                                                                                                                                                                                                                                            |
| `builder`  | author and operate                   | everything except `space-settings:*`, `space-members:*`, `api-keys:*`                                                                                                                                                                                                                                                                                                   |
| `operator` | use what is built                    | `agents:read/run`, `skills:read`, `mcp-servers:read`, `runs:read/cancel` (own runs only — `runs:read-all` is `admin`/`builder`), `files:read`, `schedules:read`, `persistence:read`, `integrations:read/connect/disconnect`, `end-users:read/write`, `chat:read/write`, `mcp:read/invoke`                                                                               |
| `runner`   | launch what is built, see only yours | `agents:run`, `runs:read/cancel` (own runs only), `files:read`, `persistence:read`, `integrations:read/connect/disconnect`, `chat:read/write`, `mcp:read/invoke`. **Not** `agents:read`, `skills:read`, `mcp-servers:read`, `schedules:read`, `end-users:*`, `runs:read-all`, nor any `:write` — a runner launches what someone else built and never reads its content. |
| `viewer`   | look                                 | the `:read` actions of `operator` (so `api-keys:read`, `space-members:read` and `webhooks:read` are **not** viewer's — they are `admin`'s)                                                                                                                                                                                                                              |

The presets are a lattice, not a chain: `viewer ⊂ operator ⊂ builder ⊂ admin` and `runner ⊂ operator`, but `runner` and `viewer` are **incomparable** — a runner launches what it cannot read, a viewer reads what it cannot launch. `SPACE_ROLE_PRESETS` is a display order; "stronger than" is computed from the matrix (`presetsStrictlyStrongerThan`), which is what a module's `presets` list must be upward-closed under (§3.5).

**Custom roles** are rows in `space_roles` (§5): an org-scoped `key`, a display name, and `permissions text[]` validated at write against the loaded space-level vocabulary (core + modules that declared `level: "space"`). A string the validator does not know is a 400 naming it — same posture as `validateScopes` for API keys. A permission that becomes unknown later (module unloaded) is ignored at resolve time; `Set.has` never sees it.

Custom roles cannot hold org-level strings. There is no "space-level custom role that also manages members of the org".

Scheduled runs re-resolve their user's space role at every fire and require
`agents:run`. Revoking the explicit membership, closing an implicitly accessible
space or removing that permission disables the schedule and records a failed run.
End-user schedules retain their pinned-space identity check.

### 3.4 Permission vocabulary by level

Org-level (granted by org roles; resource rows live at the org):

| Resource                                          | Actions                                   | Notes                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org`                                             | `read`, `update`, `settings`, `delete`    | `update` = name/slug, owner only (`PUT /api/orgs/:orgId`). `settings` = `PUT /api/orgs/:orgId/settings`, owner+admin. Two permissions rather than one, because the two routes have different audiences.                                                         |
| `members`                                         | `read`, `invite`, `remove`, `change-role` | Finally enforced by guards; the who-manages-whom policy stays the second layer.                                                                                                                                                                                 |
| `roles`                                           | `read`, `write`, `delete`                 | Custom space-role definitions. `read` is held by every org role except `guest` — delegated space administrators use the filtered space catalog (§6.4), including org guests. `write`/`delete` are owner/admin and additionally require `features.custom_roles`. |
| `spaces`                                          | `read`, `write`, `delete`                 | `read` = list (filtered, §6.3). `write` = create. Per-space edits are `space-settings:write`.                                                                                                                                                                   |
| `models`, `proxies`, `model-provider-credentials` | `read`, `write`, `delete`                 | org-wide infrastructure                                                                                                                                                                                                                                         |
| `api-keys`                                        | —                                         | space-level, because a key is space-bound (`api_keys.space_id NOT NULL`) — actions in the space table below                                                                                                                                                     |
| `llm-proxy`                                       | `call`                                    | `/api/llm-proxy` is not space-scoped; metered per org. Granted to member and guest.                                                                                                                                                                             |
| `oauth-clients`, `cli-sessions` (oidc)            | module-declared                           | owner/admin. `oauth_client.space_id` nullable stays an implementation detail of the oidc module; the permission is org-level.                                                                                                                                   |
| `org-webhooks` (webhooks)                         | `read`, `write`, `delete`                 | The `level = "org"` half of the webhooks vocabulary; `webhooks` below is the space half.                                                                                                                                                                        |
| `billing` (module-ee)                             | `read`, `manage`                          | §10                                                                                                                                                                                                                                                             |

Space-level (granted by space roles; resource rows carry `space_id`):

| Resource                | Actions                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space-settings`        | `write`                                                                                 | `PATCH /api/spaces/:id` (name, settings, visibility, default role). Preset `admin` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `space-members`         | `read`, `invite`, `remove`, `change-role`                                               | Preset `admin` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `agents`                | `read`, `write`, `configure`, `delete`, `run`                                           | Authoring happens from a space; the package row is org-scoped, readable from the spaces it is installed in and from its home. `configure` also gates INSTALL/config/uninstall of an agent in a space (`POST`/`PUT`/`DELETE /api/spaces/:spaceId/packages`) — installing decides which space runs an agent, it does not author one. A draft, its versions and its identity are governed by the agent's HOME space alone (§6.9). `run` also grants the summary projection of three read routes — the agent list, the agent detail, and the resolved model the launch form reads (`GET /api/agents/{scope}/{name}/model`) — which carries `input`, `output`, the enforced timeout and `dependencies.integrations` (a launcher connects the accounts, and holds `integrations:connect` to do it) but no manifest, prompt, authoring history, nor the skills and MCP servers the agent is built from (`dependencies.skills`, `dependencies.mcp_servers`, absent rather than empty); every other agent route still requires `read`. |
| `skills`, `mcp-servers` | `read`, `write`, `delete`                                                               | same; `write` is also the space-install permission for those types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `integrations`          | `read`, `write`, `delete`, `install`, `uninstall`, `configure`, `connect`, `disconnect` | `configure` = OAuth clients + per-space defaults (`routes/integrations.ts`). Session-only, never API-key-grantable, so a key cannot reach it even when its creator holds it. `install`/`uninstall` are also the space-install permissions for this type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runs`                  | `read`, `read-all`, `cancel`, `delete`                                                  | `read` is the runs the principal launched, its own schedules' runs included; `read-all` widens it to every run in the space — colleagues', end-users', and the actor-less rows older launch paths left. `admin`/`builder` hold `read-all` by derivation, `operator`/`viewer` do not, and a custom role can grant it. `cancel`/`delete` gate the ACTION; visibility gates WHICH rows, so a run the caller may not read answers 404, never 403.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `files`                 | `read`, `delete`                                                                        | per-file container ACL unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `schedules`             | `read`, `write`, `delete`                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `persistence`           | `read`, `delete`                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `end-users`             | `read`, `write`, `delete`                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `api-keys`              | `read`, `create`, `revoke`                                                              | preset `admin` only. A key delegates its creator's effective set in that space (§7.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `credential-proxy`      | `call`                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `webhooks` (webhooks)   | `read`, `write`, `delete`                                                               | the `level = "space"` half                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `chat` (module-chat)    | `read`, `write`                                                                         | requires `chat_sessions.space_id` (§5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mcp` (mcp)             | `read`, `invoke`                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The level is declared once, in core, next to the resource: `CORE_RESOURCE_LEVELS: Record<CoreResource, "org" | "space">`, and a unit test asserts every `CoreResource` has one. `SPACE_LEVEL_PERMISSIONS` / `ORG_LEVEL_PERMISSIONS` derive from it and are what the custom-role validator and the preset typing use — a preset that lists an org-level string is a TypeScript error.

### 3.5 Module contract

`ModulePermissionContribution` (`packages/core/src/module.ts`) is a discriminated union on `level`, because a single `grantTo: OrgRole[]` cannot express a space-level grant.

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

`level: "org"` requires `grantTo` and forbids `presets`; `level: "space"` the reverse, enforced by the type and again at boot. `presets` must additionally be **upward-closed** under the preset lattice (§3.3): naming a preset also names every preset that already grants a superset of it, or the stronger role would hold less than the weaker one for that one resource. A boot error, not a warning. `runner` and `viewer` are incomparable, so a read resource may be granted to `viewer` without `runner` and an action resource to `runner` without `viewer`. Every contributing module declares its level: there is no default, and a `grantTo` on a space-level entry is refused rather than read charitably (`NO_TRANSITIONAL_CODE.md` §1).

A second, new module surface — `principalPermissions` — is the generic mechanism a module uses to grant **org-level** strings to a specific user rather than to a role. `module-ee` uses it for billing managers (§10). Signature and caching in §4.2.

### 3.6 Personal spaces

`spaces.owner_user_id` names the ONE member a space belongs to — "Mon espace", one per member per organization, `visibility = 'private'`, never the default space. It is a **structural property of the row**, not a role and not a feature flag: three DB CHECKs hold it (`spaces_personal_is_private`, `spaces_personal_not_default`, `spaces_orphaned_is_personal`) and a partial unique index (`uq_spaces_org_owner`) holds the one-per-member rule.

**Resolver.** `resolveSpaceRole` reads that column FIRST, before the org role:

```ts
if (space.ownerUserId !== null) {
  if (space.ownerUserId !== callerId) return null;
  return { preset: orgRole === "guest" ? "operator" : "admin" };
}
```

So an organization owner or admin resolves to `null` in somebody else's personal space, and because the space is `private` every caller renders that `null` as **404**: it does not exist for them.

The owner's own preset is `admin` — **except a `guest`, who holds `operator`**. A guest is an external identity with no implicit reach into any space (§3.2), invited to USE one thing; `admin` in their own space would let them author and launch arbitrary agents on the organization's LLM budget, which is precisely what their org role withholds. `operator` is receive-and-run: read, launch, manage their own connections, no `<type>:write`. That constraint is honoured by package sharing (§6.10): **accepting a share into one's own personal space requires none of the type's install grants** (`spacePackagePermission(type, "install")` — `agents:configure` for an agent, `integrations:install` for an integration, `<type>:write` for the rest). `POST /api/packages/{scope}/{name}/shares/accept` installs on the space owner's behalf, authorized by the offer plus the owner's own call, because an `operator` holds none of those.

`callerId` is the fourth argument, passed explicitly by all eight call sites — it is the user whose personal spaces are reachable. It is `null` for an **API key** (pinned to one space, carrying its creator's authority and not their privacy), for an **end-user**, and under a **role preview** (a persona has no personal space, and `X-View-As` naming one is a 400 `invalid_view_as`). It is NON-null for a session AND for the `deferOrgResolution` strategies — the CLI device-flow token and the MCP instance token — which are the human's own credential by another transport, the same reading `viewAsTransportGuard` takes. `lib/view-as.ts` → `callerPersonalOwnerId` is the single answer to "who is that".

`packageAccessSpaces` narrows in SQL as well (`owner_user_id IS NULL OR owner_user_id = $caller`): with one personal space per member, loading the organization's spaces to filter them in TS would grow every catalog read with the headcount.

**Admin non-access, and the two acts that remain.** Owners and admins neither read nor write a personal space. Combined with §6.9 (write authority is the home space) they never need to: a package shared out of a personal space is edited by its author, wherever it is installed. `managesOrgCatalog` answers for `home_space_id IS NULL` and for nothing else, so it is never a fallback authority over a package homed in someone's personal space. What is left applies to an **orphaned** space only — one whose owner has left the organization — and both acts are audited:

| Route                                  | Permission                            | Effect                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/spaces/:id/convert-to-team` | org `spaces:write`, API keys refused  | `owner_user_id = NULL`, `orphaned_at = NULL`, `visibility` stays `private`. No `space_members` row is written: only an orphaned space converts, so its former owner is not a member and has no standing. Audit `space.converted_to_team` |
| `POST /api/spaces/:id/sweep-now`       | org `spaces:delete`, API keys refused | Runs the offboarding routine on ONE orphaned space now. Audit `space.swept`                                                                                                                                                              |

**404 before 409 on all three acts.** `DELETE /api/spaces/:id`, `convert-to-team` and `sweep-now` share ONE decision (`assertSpaceAdminAct`, `services/spaces.ts`), because a named 409 on a LIVE personal space that is not the caller's would confirm that the id IS somebody's personal space — the one fact every other route withholds from them. The rule, in order:

- a **team space**: `delete` proceeds; the two personal-space acts are 409 `space_not_personal`.
- a personal space the caller **owns**: 409, named — `personal_space_not_deletable` for the delete, `personal_space_not_orphaned` for the other two. They can see the space, so the reason discloses nothing.
- a personal space that is **orphaned**, to an owner or admin: the act runs. Such a space is already listed to them, so there is nothing left to withhold. `delete` is still 409 `personal_space_not_deletable`: `sweep-now` is the route that empties it first.
- anything else — a live personal space that is not the caller's: **404**. "The caller's" is `callerPersonalOwnerId`, so an **API key** and a **role preview** are never the owner: a key holds its creator's authority, not their privacy, and a named 409 from it would be the one route confirming that an id is their personal space.

A LIVE personal space is therefore never convertible. Taking over an active member's private workspace is not an administrative act; the transfer exists to keep what a DEPARTING member built.

**A personal space holds no non-human identity.** Three creations refuse one, all with a 409 and all for the same reason — such an identity outlives, or never had, the one person the space exists for:

| Route                                                | Code                                    |
| ---------------------------------------------------- | --------------------------------------- |
| `POST /api/api-keys`                                 | `personal_space_takes_no_keys`          |
| `POST /api/end-users`                                | `personal_space_takes_no_end_users`     |
| `POST /api/oauth/clients` (space-level, oidc module) | `personal_space_takes_no_oauth_clients` |

A key carries no user, so `callerPersonalOwnerId` is `null` for it and the resolver would answer `null` here: a key minted in a personal space would 404 on every request it ever made. An end-user is an external identity somebody else signs in as, and an OAuth client is the automation that lets them — both would point at a space that exists for exactly one member and goes away with them. A 409 rather than a 404 in all three because the caller is necessarily that space's owner — nobody else reaches it. `applySpacePermissions` additionally refuses a personal space to any principal with no org role (an OIDC end-user token) with a **404**, because such a principal never reaches `resolveSpaceRole` and would otherwise keep its strategy's fixed allowlist there.

**Write rules.** `owner_user_id` is not a body field anywhere (`POST /api/spaces` is `.strict()`). `PATCH /api/spaces/:id` accepts `name` only — `visibility` or `default_role` on a personal space is **409 `personal_space_immutable`**. `DELETE /api/spaces/:id` is **409 `personal_space_not_deletable`**: the space goes away through offboarding, not by an administrative act. `space_members` writes targeting one are **409 `personal_space_has_no_members`** — a personal space has exactly one member, its owner, and no row for them; collaboration goes through a team space. Deferred grants (an invitation's `space_assignments`, an OAuth signup policy's `signup_space_assignments`) are refused at write with a 400 and excluded again at apply.

**Provisioning.** One seam, `provisionMember(tx, orgId, userId, role)`, behind all four membership doors — org creation, invitation accept, OIDC auto-provision, first-boot bootstrap — writing the membership row and the personal space in the SAME transaction. Org creation and bootstrap go through `provisionOrg` (`@appstrate/db/provision-org`, which also brings the DEFAULT space into the org transaction); `ensurePersonalSpace` is one upsert on `uq_spaces_org_owner`, so two concurrent provisions cannot both insert. `GET /api/spaces` repairs the caller's own lazily — for any principal `callerPersonalOwnerId` answers for, i.e. a session or a `deferOrgResolution` token (CLI, MCP instance), never an API key or an end-user — which is what makes the backfill script optional for anyone who logs in. `ensurePersonalSpace` reads before it writes (the `createDefaultSpace` shape) so that repair is not a WRITE on every dashboard poll; the upsert remains the path that provisions, and the one that is race-safe.

**Offboarding.** `removeMember` stamps `spaces.orphaned_at` inside its transaction instead of deleting anything. For 30 days (`PERSONAL_SPACE_GRACE_DAYS`) the space is listed to owners and admins with `access: "none"` and an `orphaned_at` on the wire — the ONE exception to `isSpaceVisibleTo` — so it can be converted; a re-invite inside the window clears the stamp and hands the space back untouched. After that the hourly `personal-space-sweeper` worker, or `sweep-now`, empties and deletes it: a package it homes goes to the organization catalogue (`home_space_id = NULL`) when another space has it installed, and is deleted when it lived only there; then the existing `deleteSpace` path runs, which is why it takes a `"sweeper"` actor. During the window a package homed in the orphaned space and installed elsewhere is **writable by nobody**: its home still exists, so `managesOrgCatalog` does not answer for it (that is `home_space_id IS NULL` and nothing else), and no live principal reaches the home. This is accepted and intended — the alternative is handing a departed author's drafts to the org catalogue the moment they leave. `convert-to-team` ends it early; the sweeper ends it at 30 days by re-homing the package to `NULL`.

`spaces.owner_user_id` is `ON DELETE RESTRICT`, and this **deviates from the plan**, which said the account-deletion path would call the sweeper first: there is no user hard-delete path in this codebase (`grep -rn deleteUser` finds none), so there was nothing to wire. What `RESTRICT` buys instead is that any future path — or an operator's ad-hoc `DELETE FROM "user"` — fails loudly with `23503` until it sweeps the personal spaces first, rather than cascading somebody's private drafts away unreviewed.

**Not gated.** Personal spaces are OSS and structural (no feature flag, which would put two paths in the resolver). The commercial module counts spaces for nothing today; if a space limit is ever added there, it counts `WHERE owner_user_id IS NULL` — otherwise the feature is a tax on every member.

---

## 4. Enforcement

### 4.1 Resolver

```ts
type SpaceRoleRef = { preset: SpaceRolePreset } | { custom: SpaceRoleRow };

function resolveSpaceRole(orgRole, space, memberRow, callerId): SpaceRoleRef | null {
  // A personal space belongs to one member and to nobody else — §3.6, ahead of
  // the org role. `callerId` is null for an API key, an end-user or a preview.
  if (space.ownerUserId !== null) {
    if (space.ownerUserId !== callerId) return null;
    // A guest holds `operator` in their own space, never `admin` — see §3.6.
    return { preset: orgRole === "guest" ? "operator" : "admin" };
  }
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

Four context keys carry the answer:

| Key              | Set by                                            | Value                                                                                                                        |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `orgPermissions` | auth pipeline, once org role is known             | org-level effective set                                                                                                      |
| `scopeCeiling`   | auth pipeline                                     | API-key `scopes`, OIDC scope claim; `undefined` for sessions                                                                 |
| `permissions`    | auth pipeline **and** `requireSpaceContext`       | `ceiling(orgPermissions)` at first; `ceiling(orgPermissions ∪ spacePermissions)` once the space is resolved                  |
| `viewAs`         | `resolveViewAs`, before every `permissions` write | Validated role preview, or unset. Narrows the two sets above to a lesser persona's; `user` and `orgRole` stay REAL. See §6.7 |

`makePermissionGuard` keeps reading `permissions` and nothing else. A route outside `SPACE_SCOPED_PREFIXES` sees org-level permissions only; a space-level string can therefore never be satisfied on an org route, which is the property we want (a `builder` cannot `agents:write` through a non-space path, because there is none).

`requireSpaceContext` gains the membership step after `validateSpaceInOrg`: load the `space_members` row for `(spaceId, userId)` (one indexed PK lookup), run the resolver, write `permissions`, set `c.set("spaceRole", ref)`. For API-key callers the pinned space goes through the same step — the key's **creator** is the user whose membership is resolved (§7.1).

`principalPermissions` is a module member, not a hook — every module that declares it contributes and the answers are unioned, which is neither dispatch mode `ModuleHooks` offers:

```ts
principalPermissions?: {
  mayGrant: readonly string[];
  resolve(ctx: { orgId: string; userId: string }): Promise<readonly string[]>;
};
```

It is awaited once per request in the pipeline, for session callers and for `deferOrgResolution` strategies (which behave like sessions) only. It is not evaluated for API keys or end-user tokens: a module may only declare session-only strings in `mayGrant` (never `apiKeyGrantable` / `endUserGrantable` ones), so those ceilings could not contain the result anyway. Each module's answer is filtered to its own `mayGrant` — an undeclared string is dropped and logged, never granted — and a throwing resolver is isolated (logged, contributing nothing), because a billing outage must not lock every admin out of the org. Results are cached with the `@appstrate/core/cache` primitive under `(orgId, userId)`, TTL 10s, and invalidated through the pg_notify bus by the module's own writes calling the core-exported `invalidatePrincipalPermissions(orgId, userId)` — a module that contributes this member owns its invalidation, the same way `module-ee` owns its billing cursor. Both arguments are required: the call drops exactly one principal on every replica, and a write touching N principals names each of them. There is no org-wide form, because the cache is keyed by the pair rather than prefixed by org — a blanket clear would drop every organization's principals to save the caller a loop. `mayGrant` is validated at boot against `ORG_LEVEL_PERMISSIONS` ∪ the loaded modules' `level: "org"` contributions, minus everything API-key- or end-user-grantable; a violation is a boot error naming the module and the string. With no module declaring the member the pipeline never reads the cache at all.

The same union is what `GET /api/orgs` and `GET /api/me/orgs` expose in their `permissions` field, through one helper (`listedOrgIdentityForCaller`, `apps/api/src/lib/principal-permissions.ts`, which returns the `role` beside it), so the two listings cannot answer differently for the same caller.

The `/api/orgs/:orgId*` family is exempt from `requireOrgContext` (the org is in the path, not in `X-Org-Id`), so the pipeline's permission step never runs for it. **One middleware** stands in — `orgPathContext` (`apps/api/src/middleware/org-path-context.ts`), mounted at the app root ahead of the orgs router AND of every module router, preceded by `apiKeyOrgScopeGuard` for the cross-org pin. It derives from the membership row for session and `deferOrgResolution` callers only, applies `scopeCeiling`, and unions the same principal grants; every other credential keeps the ceiling-limited set the pipeline already wrote. A module mounting under `/api/orgs/:orgId/…` (oidc's `cli-sessions`) inherits it and derives nothing of its own: a second derivation reading the membership row would overwrite the ceiling, letting an API key scoped to `runs:read` reach those routes with its creator's full org authority.

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
    CHECK (default_role IN ('admin', 'builder', 'operator', 'runner', 'viewer')),
  ADD CONSTRAINT spaces_default_is_open CHECK (NOT is_default OR visibility = 'open');

-- personal spaces (§3.6)
ALTER TABLE spaces
  ADD COLUMN owner_user_id text REFERENCES "user"(id) ON DELETE RESTRICT,
  ADD COLUMN orphaned_at   timestamptz,
  ADD CONSTRAINT spaces_personal_is_private   CHECK (owner_user_id IS NULL OR visibility = 'private'),
  ADD CONSTRAINT spaces_personal_not_default  CHECK (owner_user_id IS NULL OR NOT is_default),
  ADD CONSTRAINT spaces_orphaned_is_personal  CHECK (orphaned_at IS NULL OR owner_user_id IS NOT NULL);
CREATE UNIQUE INDEX uq_spaces_org_owner ON spaces(org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

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
  CHECK (key NOT IN ('admin', 'builder', 'operator', 'runner', 'viewer'))
);
CREATE INDEX idx_space_roles_created_by ON space_roles(created_by);   -- referencing side of SET NULL

-- explicit membership
CREATE TABLE space_members (
  space_id       text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  preset_role    text CHECK (preset_role IN ('admin', 'builder', 'operator', 'runner', 'viewer')),
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

-- OAuth organization signup uses the same assignment entries
ALTER TABLE oauth_clients
  ADD COLUMN signup_space_assignments jsonb NOT NULL DEFAULT '[]';

-- chat sessions become space-scoped
ALTER TABLE chat_sessions ADD COLUMN space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX idx_chat_sessions_space_user ON chat_sessions(space_id, user_id);
```

Design notes:

- **Presets are not rows** so the preset-or-custom choice is two nullable columns with a `num_nonnulls` check rather than one column mixing a key and an id. Both halves are DB-enforced: presets by CHECK, customs by FK.
- **`ON DELETE RESTRICT` on `custom_role_id`**: deleting a role still assigned is a 409 naming the count. Reassign first. (GitHub silently drops access on delete; a loud refusal is more in keeping with this codebase.) Pending invitations also block deletion; OAuth signup policies are validated again at signup (§7.2).
- **`default_role` is a preset only.** A custom default for open spaces is YAGNI; it would need a second nullable column and a third check for one setting nobody asked for.
- **Space delete cascade** (`SPACES.md` §Delete cascade) gains `space_members` for free through the FK; nothing to add to `deleteSpace`.
- **Org delete** cascades `space_roles` via `org_id`.
- `visibility` is a `text` with a CHECK, not a pg enum — same choice as `webhooks.level`; adding a value is a migration either way and text spares the enum-rewrite dance.

---

## 6. HTTP surface

Casing per `docs/CASING_CONVENTIONS.md`: snake_case on the wire, with the `id`/`*Id` carve-outs.

### 6.1 Org users — `/api/orgs/:orgId/members`

Guarded by `requirePermission("members", …)`; the assignable-role policy runs in the handler after it. `role` accepts `admin | member | guest`. The invite body carries `space_assignments`: guests require at least one, admins require an empty list, members may carry explicit grants, and every space and custom-role reference must belong to the organization. Acceptance consumes the role and assignments returned by the atomic token claim, so an edit committed before the claim takes effect. It applies the grants in the membership transaction; deleted targets are skipped and logged.

One pending invitation exists per (organization, email) — the partial unique index `uq_org_invitations_pending` (§11). A second create for an address that already has a valid pending row is a 409 `invitation_already_pending` carrying its `invitation_id`, not a cancel-and-replace: the first link stays valid and its assignments stay. An expired-but-unswept row is cancelled so a fresh invitation can follow it.

### 6.2 Roles — `/api/roles` (org-scoped)

| Method   | Path                    | Permission                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/roles`            | `roles:read`                            | presets (`kind: "preset"`, read-only, with their permission list) + custom rows (`kind: "custom"`)                                                                                                                                                                                                                                                                                                                            |
| `POST`   | `/api/roles`            | `roles:write` + `features.custom_roles` | `{ key, name, description?, permissions[] }` → 201                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH`  | `/api/roles/:id`        | `roles:write` + flag                    | name/description/permissions                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DELETE` | `/api/roles/:id`        | `roles:delete` + flag                   | 409 `role_in_use` with `{ member_count, pending_invitation_count }`                                                                                                                                                                                                                                                                                                                                                           |
| `GET`    | `/api/roles/vocabulary` | `roles:read`                            | the space-level strings a custom role may hold, grouped by resource; each entry is `{ permission, action, api_key_grantable }`. No `level` field: a custom role holds space-level strings by construction, so reporting the level on every entry would be one constant repeated. End-user grantability is absent for the same reason — it is a property of an OIDC token's scope claim, not of a bundle a space role may hold |

Without the flag the three write routes answer 403 `feature_unavailable`. Object discriminator: `object: "role"`. Audit: `role.created` / `role.updated` / `role.deleted`.

### 6.3 Spaces — `/api/spaces`

`GET /api/spaces` filters by caller:

| Caller        | Sees                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| owner / admin | all spaces                                                                                                      |
| member        | `open` (implicit) + `closed` (listed, `access: "none"`, cannot enter) + `private` **only** with an explicit row |
| guest         | explicit rows only                                                                                              |
| API key       | its own space only (unchanged), and never a personal space                                                      |

A caller's OWN personal space is in every listing (`GET /api/spaces` provisions it if missing), nobody else's is — except an ORPHANED one, listed to owners and admins with `access: "none"` so they can convert or sweep it (§3.6). Each item carries `personal: boolean`; `orphaned_at` is added on the owner/admin projection only. The owner of a personal space is deliberately not named on the wire.

Each item gains `visibility`, `default_role`, `access: "member" | "none"`, `role` (`{ kind, key, name }` or `null`) and `permissions: string[]` — the caller's effective set in that space, already ceiling-applied. The SPA reads nothing else to decide what to render (§8).

`PATCH /api/spaces/:id` moves from `spaces:write` to `space-settings:write` and accepts `visibility` and `default_role`. Setting `visibility` to anything but `open` on the default space is a 400 (the DB check backs it). Changing a default preset (including on a closed/private space), or opening a space with that preset, must not grant permissions beyond the actor's effective set in that space. `POST` stays `spaces:write`; the creator is **not** given a row — they are an admin already, or they could not create.

### 6.4 Space members — `/api/spaces/:id/members`

| Method   | Path                              | Permission                  | Notes                                                                                                                                                                                                                                                    |
| -------- | --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/spaces/:id/members`         | `space-members:read`        | explicit rows always; the IMPLICIT ones (`source: "org_role" \| "open_space"`) are the org directory seen through a space and need `members:read` too, so a guest holding preset `admin` here manages what the space granted and enumerates nothing else |
| `POST`   | `/api/spaces/:id/members`         | `space-members:invite`      | exactly one of `userId` or `email`, plus exactly one role reference; existing org member only; 409 for owner/admin or an existing explicit row                                                                                                           |
| `PATCH`  | `/api/spaces/:id/members/:userId` | `space-members:change-role` |                                                                                                                                                                                                                                                          |
| `DELETE` | `/api/spaces/:id/members/:userId` | `space-members:remove`      | removing a `member` from an open space leaves them implicit — the route says so in the response (`access_after: "implicit" \| "none"`)                                                                                                                   |

Audit: `space.member_added` / `space.member_role_changed` / `space.member_removed`.

`POST` only creates an explicit row; it never updates a prior assignment or substitutes for `PATCH`. Email lookup trims and lowercases an exact address inside the current organization. Unknown and outside-org addresses return the same 404. The space page can add an existing org user by email without exposing the org directory; inviting a new org user remains a separate `members:invite` action through the organization Users page.

All explicit assignments, including self-changes, must be subsets of the actor's effective, credential-ceilinged space permissions. Removing a row is subject to the same check on the implicit preset it exposes. An invite-only, change-role-only or settings-only custom role cannot use delegation to obtain permissions it lacks. Full space admins can manage every preset, including restoring a member whose explicit role lowered them.

That rule is checked where the actor is present. The DEFERRED assignments — the `space_assignments` an org invitation carries, and the ones an OAuth-signup policy applies when an end user first arrives (`apps/api/src/services/space-assignments.ts`) — are validated for org ownership and for the preset/custom role rules only, because the assignment is applied later, without the actor and without a request to read a ceiling from. What holds the guarantee there is the permission that reaches the route in the first place: `members:invite` and `members:change-role` are ORG-level and granted to `owner` and `admin` alone, and those two hold every space-level permission in every space (`resolveSpaceRole` returns preset `admin` for them). An actor who can create such an invitation therefore cannot name a role they do not already hold — the subset check would be vacuous, not skipped. Granting either permission to `member` or `guest` would silently break that, so `apps/api/test/unit/lib/deferred-assignment-authority.test.ts` refuses the grant.

`GET /api/spaces/:id/roles` accepts any of `space-members:invite`, `space-members:change-role` or `space-settings:write` — one `requireAnyPermission([…])` (`apps/api/src/middleware/require-permission.ts`), which audits the denial naming every alternative. It returns the standard role objects filtered by the same grantability predicate as writes, and is available to guest space administrators. The frontend uses it for membership roles and default presets without duplicating authorization rules.

### 6.5 Org list — `GET /api/orgs`

Each item gains `permissions: string[]` (org-level effective set, principal grants included). `role` stays for display. Org detail returns `members: []` without `members:read` and `invitations: []` without `members:invite`; `org:read` alone never exposes the directory, invitation tokens or deferred space grants.

### 6.6 OpenAPI

Every new route in `apps/api/src/openapi/paths/`, 403 documented on every guarded route (the static analyzer in `scripts/verify-openapi.ts:1963` enforces it), `bun run openapi:baseline` regenerated. `detect:breaking` flags `viewer` leaving the role enum and `PATCH /api/spaces/:id` changing its permission — both intended.

### 6.7 Role preview — `X-View-As`

An owner or administrator can have any authenticated request answered as a lesser _persona_ — an org role (`member` | `guest`), optionally with a preset or custom role in one space — to see what a role reaches before assigning it. It is a pure restriction computed from the caller's own session: nothing is minted, `user` and `orgRole` stay real, and it is applied at the sites that already write `permissions` (§4.2, key `viewAs`).

Three carriers, one validation, and one vocabulary shared by every end (`@appstrate/core/permissions`):

| Constant                | Value              | Carries                                                                                                                                                                                                           |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIEW_AS_HEADER`        | `X-View-As`        | `org_role=member; space=spc_…; role=preset:viewer` — `space` and `role` optional as a PAIR; `role` is `preset:<admin\|builder\|operator\|runner\|viewer>` or `custom:<srl_ id>`. Sent by `buildScopingHeaders()`. |
| `VIEW_AS_QUERY`         | `view_as`          | The same grammar on `/api/realtime/*`, where `EventSource` cannot send headers. The header is REFUSED there, never ignored.                                                                                       |
| `VIEW_AS_ACTIVE_HEADER` | `X-View-As-Active` | Response marker, `1`, on every response produced under a validated persona and only then.                                                                                                                         |

The chat module's in-process loopback carries the persona in its signed claims instead, so a tool call the engine makes under a preview reaches exactly what the previewed role reaches.

Eligibility is cookie sessions and the CLI/instance token, real org role owner or admin. Every refusal is a refusal of the REQUEST, never a fall-back to the caller's real permissions, and `VIEW_AS_REFUSAL_CODES` is the complete set:

| Code                  | Status | When                                                                                                                                                                                    |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_view_as`     | 400    | The header does not parse (bad grammar, unknown key, `space` without `role`)                                                                                                            |
| `view_as_unsupported` | 400    | The credential cannot carry a persona: API keys, OIDC dashboard/end-user tokens, MCP bearers. Cookie sessions and the CLI/instance token — which authenticate the user themselves — can |
| `view_as_forbidden`   | 403    | Real role not owner/admin, role not grantable by the caller in that space, or a custom role with `custom_roles` off                                                                     |
| `view_as_not_found`   | 404    | The space, the custom role or the organization the persona names is not the caller's                                                                                                    |

`GET /api/orgs` and `GET /api/me/orgs` are exempt from `requireOrgContext`, so on those two the persona needs `X-Org-Id` to say which organization it applies to: without it `400 invalid_view_as`, and naming an org the caller is not a member of is `404`. Every other row in those listings stays the caller's real role.

**Client rule: on any of the four codes, drop the persona** — do not retry the request without the header, do not keep previewing. A plain `404 not_found` answered UNDER an active persona is a different thing: the previewed role's own wall (a private space it cannot see), and the preview must be left standing for it. That is why the discriminator is a code and not the absence of the marker.

A persona carries no per-principal (module) grants: a grant a module made to the administrator personally — the EE module's billing managers, say — is an attribute of that person, not of the role being previewed.

Writes are allowed under a persona: blocking them would make "can this role run an agent" untestable, and the persona is a strict downgrade whose audit row (`after.view_as`, beside the real `actor_id`) names it. A **run** launched under a preview still executes with the real actor and the run's own server-minted credentials — the run plane carries no persona. The chat module's loopback is the one exception, and it exists because that hop re-enters the API as the caller rather than leaving it.

**Principle: restriction only, never mint.** The persona is computed from the caller's own session and can only remove; no token is minted or swapped for it — the 2018 Facebook "View As" breach was a preview that minted an access token for the viewed profile, and 30M tokens were stolen. The prior art the design follows is [WordPress _View Admin As_](https://wordpress.org/plugins/view-admin-as/) (a non-destructive downgrade of one's own capabilities, with one visible exit) and [Retool](https://docs.retool.com/apps/guides/app-management/share) (preview as a first-class mode of the editor); the counter-example is [Airtable's interface preview](https://support.airtable.com/docs/managing-and-sharing-interfaces), which [reportedly](https://community.airtable.com/interface-designer-12/interface-is-not-allowing-collaborator-to-add-new-item-to-single-select-field-38458) "at times uses the permissions of the actually logged in user" — a preview the server does not enforce is worse than none.

**Not done, deliberately.** Eligibility stops at org owner/admin, so "never elevate" is trivially true; widening it to a space `admin` previewing a lower role in their own space is a change to the eligibility check plus a space-half intersection (§4.2). Previewing a specific USER (`{ user_id }`, reading their real rows) reuses every carrier here but needs a policy of its own — consent, notification, and no writes — and is not built. Previewing a credential is not planned: an API key's reach is already inspectable from its scopes.

### 6.8 Package catalogs and shared mutations

`GET /api/spaces/:id/packages` filters installed entries by the caller's type-specific read permissions, with the credential ceiling applied, and `GET /api/spaces/:id/packages/:scope/:name` gates on `spaces:read` **and** the row's own type `:read` — the detail route can never answer for a type the listing hides. `GET /api/library` returns accessible spaces only. A package and its installation metadata require type-specific read permission in at least one accessible installation; hidden installations are omitted. System packages remain available with that read permission. Org owners/admins may also manage uninstalled org catalog entries, subject to credential permissions; space-pinned API keys do not gain this org catalog exception.

A package's draft, versions and identity are shared across its installations, and **`packages.home_space_id` alone says who may change them** — see §6.9. Hidden catalog ids return 404; a package the caller can see but does not govern returns 403. Bulk requests authorize all targets before modifying any.

Installing or importing an existing package also requires readable source access and the target installation permission. Forks and exports check readable source access; REST and MCP bundle routes use the same policy. Caller-authored inline manifests must have read access to every existing named dependency before readiness can expose metadata or a run can consume content. Runtime resolution of already-authorized stored agents retains its existing dependency contract.

### 6.9 Package write authority — the home space

`packages.home_space_id` names the ONE space whose `<type>:write` (or `<type>:delete`) authorizes editing, publishing, restoring, renaming and deleting a package. Every other space it is installed in **consumes** it: an installation grants use and per-space configuration (`space_packages`), never a say over the draft. `NULL` is the organization catalogue — owners and admins on a **session**, the reach `managesOrgCatalog` describes; an API key, pinned to one space, never has it.

The home is set at creation, from the space the creation ran in: the package routes, a ZIP/bundle/GitHub import and a fork (the DESTINATION space, not the source's home). An org-level creation with no space context — and the boot sync of system packages — leaves it `NULL`, and so does an inline run's shadow row, which no package route can reach. `assertPackageMutationAccess` (`apps/api/src/lib/package-access.ts`) is the single reader.

`assertPackageMutationAccess` asks that ONE question. There is no second permission check against the space the request happens to come from: `requirePackageInOrg()` is the whole authorization of a mutation route, and the routes carrying it have no `requirePermission(resource, "write")` beside it. Adding one back would restore the conjunction "home AND wherever I am browsing from", i.e. cost a builder the edit of their own package from any space where they only read. The home lookup runs through `packageAccessSpaces` → `effectiveInSpace`, so it already applies the view-as persona and the credential ceiling, and an API key is already pinned to its own space. The routes that DO keep a current-space guard are the ones acting on the installation rather than the package — install, uninstall, configure, per-space settings. **Importing over an existing package** (ZIP / bundle / MCP import, `routes/packages.ts` → `handleImport`, `lib/package-access.ts` → `authorizeBundlePackages`) is deliberately in that set even though it also rewrites the draft: an import INSTALLS into the current space as well as overwriting, so the current-space `<type>:write` is required by that half of the action, and `assertPackageMutationAccess` then asks the home for the other half. Both are needed; neither substitutes for the other.

The home is also a READ grant, and not only in the catalog check: a package is readable from the spaces it is installed in **and** from its home, so a draft installed nowhere stays visible to its author, and so does one installed only in spaces the author cannot reach. `placementGrantsRead` (`apps/api/src/lib/package-access.ts`) is the single statement of that rule, and it has exactly FOUR readers: the catalog check, the per-space visibility gate of the package read routes (`isPackageReadableInSpace`), `GET /api/library` and the per-type index listing (`listOrgItems`, whose SQL mirrors the predicate — the `activeOnly` narrowing the integration picker uses stays install-only, since the home is not a usable instance).

Everything else stays INSTALL-gated, and two families of route are worth naming because "the home is a read grant" reads as if they were not:

- the `requireAgent()` family — `GET /api/agents/{scope}/{name}/model`, `/proxy`, `/schedules`, the persistence routes, the per-space input settings. That guard resolves the agent through `getPackageWithAccess` → `hasPackageAccess`, i.e. through the INSTALLATION in the current space, and deliberately keeps doing so: those routes answer about an agent AS CONFIGURED HERE, and there is no per-space configuration where there is no installation. A package homed in a space that has uninstalled it answers 404 on them, which is correct rather than an oversight. `GET …/bundle` asks `hasPackageAccess` itself, for the same reason, only inline (it distinguishes "not in this organization" from `agent_not_installed_in_space` so the CLI can offer to install).
- RUNNING it, from the same predicate: a package readable at home is not thereby executable there.

The two halves are `packages/…/{scope}/{name}` (the package itself — home-readable) versus `agents/{scope}/{name}/…` (the installation — install-gated), and the split is the same one §6.9's write rule draws.

**On the wire**, a package read never carries the raw column. Every shape that names a home — `AgentDetail`, `OrgPackageItem`, `OrgPackageItemDetail`, `LibraryPackageList` — carries a PAIR, computed in one place (`homeWireForCaller`, `apps/api/src/lib/package-access.ts`):

- `home_space_id: string | null` — the home's id **only when the caller reaches that space** (its `packageAccessSpaces` set), `null` otherwise. The raw column cannot be published: a package homed in a member's personal space is legitimately readable by everyone it is installed for, and its id would hand each of them a space §3.6 says does not exist for them. `null` therefore means "not a space you can see" — the organization catalogue and a withheld home alike — and nothing downstream needs to tell those apart.
- `home_writable: boolean` — whether THIS caller holds the type's `write` in the home, from `holdsHomeAuthority`, the same predicate `assertPackageMutationAccess` enforces. Always emitted, a summary read (`agents:run` without `agents:read`) included: an absent boolean would read as "not answered yet" rather than "no".

The SPA derives no write authority of its own; it gates edit, publish, move and delete on `home_writable`. (Delete and write travel together in every preset; a custom role granting one without the other over-offers a button the API then refuses, which is accepted.) The only client-side use of `home_space_id` is naming the home and excluding it from the move dialog's destination list.

**Moving it** is `PATCH /api/packages/{scope}/{name}` with `{ "home_space_id": … }`. The caller must hold the type's `write` in the current home (or be an owner/admin when it is `NULL`) **and** in the destination, which must be a space they can reach — an unreachable destination answers 404, never confirming it exists. Setting it to `NULL` hands the package to the organization catalogue and is therefore owner/admin only.

A space with runs in progress cannot be deleted either: `DELETE /api/spaces/{id}` answers **409 `space_has_active_runs`** while any run in it is `pending` or `running`, for every actor, the offboarding sweeper included (it logs the refusal and retries next pass). The delete cascade-drops `runs`/`run_logs`, so performing it under a live container rips the rows out from under it — the same rule organization deletion has, from the same predicate (`countInProgressRuns`, `services/state/runs.ts`).

A space that homes a package cannot be deleted: `DELETE /api/spaces/{id}` answers **409 `space_homes_packages`** and names them. Re-homing them silently would move write authority without anyone asking, and deleting them would destroy catalogue entries other spaces are running — so moving them is the caller's act. Inline-run shadow rows carry no home for exactly this reason: a run must not make its space undeletable.

This replaces the earlier rule, which required the permission in each space where the package was installed. That cost an author the edit of their own package as soon as anyone installed it into a space the author cannot read, and made a package installed in five spaces writable only by whoever administers all five.

**Deploying it.** Existing rows get `home_space_id = NULL`, i.e. the org catalogue, so between the migration and the backfill every non-owner author — and every API key, which never has catalogue authority — loses write access to its own packages. Close that window the way `0008` did: **stop the platform, run the migrations only, run `scripts/migration/0013-packages-home-space-backfill.sql`, then bring the new version up.** Nothing serves traffic in between.

---

### 6.10 Sharing — a package's audience

`package_shares (package_id, space_id, shared_by, created_at)` says a package is **offered** to a space. `space_packages` says it is **activated** there. Two tables, two acts, and the split is the whole design: a package runs with the RECIPIENT's credentials, so activating one has to be the recipient's own decision — and an "offered but not accepted" state carried on `space_packages` would have had to be filtered at each of that table's readers, where one miss executes a package nobody consented to.

**The subject is a space, never a user.** "Share with Bob" is a share with Bob's personal space, resolved server-side from his user id (`ensurePersonalSpaceFor`, the same provisioning the `GET /api/spaces` repair performs — one function, because creating your own personal space and creating a recipient's are the same act on the same row) — and the offer route is the one path that runs it for somebody else, because a member who has not opened the dashboard yet has no space. A revoke does NOT provision one (`findPersonalSpace`): withdrawing is not granting. The sharer never learns that id: `GET …/shares` renders a personal-space target as its OWNER. A space is already the group primitive (a `closed` space with three members is a group), so no `package_grants`, no audience enum and no user-group table exist.

**Authority is the home space**, the same one §6.9 defines, under a third verb: `<type>:share`. The `admin` and `builder` presets hold it (both derive their grants from the catalog); `operator`, `runner` and `viewer` do not, and no API key ever carries it — the key allowlist is a hand-written list and `share` is absent from it, so `validateScopes` refuses it at mint time. `assertPackageShareAccess` is the single reader, beside `assertPackageMutationAccess`, with the same 404/403 split: an id the caller cannot reach stays a 404. A NULL home means the organization catalogue — owners and admins in session. A SYSTEM package is a 403: it is already readable in every space.

| Route                                                 | Authority                                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/packages/{scope}/{name}/shares`            | `<type>:share` in the home; `members:read` too for a `user` target | Idempotent insert (200 either way). `409 share_target_is_home` when the target IS the home; 404 for a space outside `packageAccessSpaces` and for a non-member. Audit `package.shared` — `{ recipientUserId, targetKind }` for a `user` target, `{ spaceId, targetKind }` for a `space` one, never the personal space id — plus a `package_shared` notification for a `user` target                                                                                                                                                                                |
| `GET /api/packages/{scope}/{name}/shares`             | `<type>:share` in the home                                         | The audience, oldest first, a personal space rendered as its owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /api/packages/{scope}/{name}/shares/{target}` | `<type>:share` in the home                                         | Deletes the share AND the `space_packages` row of that space, in ONE transaction. `target` is the handle the listing published: a space id, or the member's user id, resolved READ-ONLY — a revoke never provisions a personal space, and a member who has none answers the same 404 as a missing row. Audit `package.unshared`, in `package.shared`'s shape plus `uninstalled`                                                                                                                                                                                    |
| `POST /api/packages/{scope}/{name}/shares/accept`     | NONE beyond the offer — see §3.6                                   | Installs into the CALLER's own personal space, pinned to `latest`. 404 without an offer — read inside the installing transaction, so a revoke racing an accept cannot leave an installation the share no longer backs — and for any principal with no personal space (API key, end-user, role preview). `409 package_has_no_version` when nothing is published. Re-calling it RE-PINS to `latest`: that is the update path. Audit `package.share_accepted` — `{ recipientUserId, versionId }`, never the personal space id, for the reason `package.shared` states |

**A share is a READ grant and nothing else.** `placementGrantsRead` (§6.9) becomes `installed ∨ shared ∨ home`, and its readers pick the share half up with it: the catalog check, `isPackageReadableInSpace`, `GET /api/library` (whose `shared` section lists exactly the offers not yet installed) and `listOrgItems`'s SQL mirror. Everything else stays on `space_packages` — execution (`hasPackageAccess`), the version pin, the per-space model/proxy, the credential resolution. **No execution path reads `package_shares`**, and the grep that proves it finds the table named only in the share service, the two placement loaders and the library.

**Installing into a personal space** has two rules of its own (`installPackage`). The package must be OFFERED there or HOMED there, else 404 — never a 403, since the space id is private. And an accepted share is PINNED (`version_id = latest` at install): without it the author publishes a v3 the recipient executes, with the recipient's credentials, having never seen it. A share with nothing published yet is refused (`409 package_has_no_version`) rather than installed unpinned, which is the same follow-`latest` behaviour under another name. A package homed there is NOT pinned — its owner is its author, and pinning a draft-only package would strand it. That only the space's owner installs there needs no check of its own: `resolveSpaceRole` answers `null` for everyone else and the space is `private`.

**Copy control** (`org_settings.restrict_package_copy`, default `false`). Reading a package implies being able to copy it — the default of Notion, Drive and Figma. An organization may close that: at `true`, the THREE routes that hand a whole package to the caller require `<type>:share` in the SOURCE's home space (owners and admins when it has none), answering `403 package_copy_restricted` otherwise:

| Route                                   | What leaves                                                              |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `POST …/fork`                           | A copy, inside the platform — possibly into another organization         |
| `GET …/{version}/download`              | The version's archive                                                    |
| `GET /api/agents/{scope}/{name}/bundle` | The agent AND every transitive dependency's stored files, in one archive |

`/bundle` is the widest of the three and was the last to be gated: read + installed used to be its whole authorization, so a restricted organization's `download` refusal was one `appstrate run --local` away from being pointless. The consequence is deliberate and is the flag's meaning, not a regression: **a local CLI run under a restricted organization answers `403 package_copy_restricted`**, because a copy of the agent leaves the platform to perform it. A SERVER-side run is unaffected — it assembles the same bundle and hands it to nobody — and so are the file-explorer content reads, which are an on-screen read of one file rather than a copy of the package.

Without the key, personal spaces open "fork it into mine, then share it on" to every reader, i.e. `share` would protect the link and not the content. SKILLS and SYSTEM packages are exempt on all three: the CLI's skills sync downloads skills into a local checkout by design and a skill's audience is already the space it is installed in, while a system package is shipped readable in every space of every organization — it has no owning space for a setting about copying OUT of one to protect, and reading its `NULL` home as the organization catalogue turned the key into "only owners and admins may install the shipped catalogue". The setting is read UNCACHED, like the OIDC SSO gate, and for a cross-organization fork it is the SOURCE organization's setting and the caller's standing there that decide.

**On the wire**, `homeWireForCaller` emits a THIRD field beside §6.9's pair: `home_shareable`, the same predicate for `share` — the one the THREE routes that change the audience enforce (offer, list, revoke). `accept` is not one of them: it is the recipient's own act and asks for no `share` at all. It is not an alias of `home_writable` — a custom role may hold either without the other — and it is what the SPA's "Share…" action is gated on.

---

## 7. Credentials other than a cookie

### 7.1 API keys

`permissions = scopes ∩ the creator's effective set in the key's space`.

- Mint: `validateScopes(scopes, creatorEffective)` where `creatorEffective` is the creator's effective set in the key's space. Non-grantable → 400; beyond the creator → filtered. Unchanged in kind.
- Request: the pipeline pins `spaceId` from the key row; `requireSpaceContext` resolves the **creator's** membership in that space and applies the ceiling `scopes`. A creator who lost the space (removed, demoted to guest without a row) leaves the key with `scopes ∩ orgPermissions` — nearly nothing, and the key 403s in that space. That is the live-ceiling semantics this design chose; no revocation sweep.
- `api-keys:*` is a space-level permission held by preset `admin`. A `builder` cannot mint keys.
- `integrations:configure` is never API-key-grantable: the property "a key cannot do this even if its creator can" is expressed in the vocabulary, not in a role check.
- `runs:read-all` is API-key-grantable — a headless supervisor needs the space-wide run view — and never end-user-grantable: it is absent from `OIDC_ALLOWED_SCOPES`, so an end-user principal stays on its own runs whatever a client asks for.
- A key reaches exactly one space, so it authorizes a package mutation in exactly one space — and a draft, its versions and its identity are shared across every installation (§6.8). A package installed in more than one space therefore cannot be mutated by any key at all, whatever its scopes: the key holds authority in its pinned space and none in the others. That is the intended reading of "a key delegates authority in one space", not a gap to widen.
- Core org-administration routes refuse API keys through non-grantable `org:*` / `members:*` / `roles:*` permissions. The OIDC module deliberately exposes `oauth-clients:*` as org-level, admin-tier, API-key-grantable authority for headless client administration. `oauth-clients:write` includes redirect, secret and org signup-policy administration (already including `signupRole: "admin"`); a space pin does not narrow this org-level authority.

### 7.2 OIDC tokens (oidc module)

- `dashboard_user` tokens: ceiling = scope claim; org slice from the subject's org role; space slice resolved per request from the subject's membership in the pinned/header space. Same path as a session with a `scopeCeiling`.
- `end_user` tokens: the fixed `OIDC_ALLOWED_SCOPES` allowlist (`apps/api/src/modules/oidc/auth/scopes.ts`) plus `endUserGrantable` module entries, single space, own rows only (`apps/api/src/lib/actor.ts`). End-users are not space members and never appear in `space_members`. Their strategy supplies no synthetic org role, so the membership resolver preserves their fixed permissions in open, closed and private spaces. Cross-space requests remain forbidden.

Org-level OAuth clients store `signupRole` and `signupSpaceAssignments` (wire camelCase consistent with the existing OAuth DTO; assignment entries use shared snake_case). Guest policies require at least one assignment even when `allowSignup` is false; admin policies require none; member policies may have explicit grants. Space- and instance-level clients cannot configure these org signup assignments.

On the first successful org signup, membership and all assignments commit atomically. Deleted spaces/custom roles cause a clear signup configuration error and no partial membership. An admin repairs the client's assignment list before new signups can resume. Existing org members always keep their current role and memberships, even if the current signup policy is closed or stale. Signup configuration does not continually synchronize members or grant future spaces.

### 7.3 MCP (mcp module)

A per-org MCP bearer re-enters space-scoped routes in-process and lands on the default space (`SPACES.md` §Resolving). With this spec that re-entry resolves the token subject's role in the default space — every `member` is implicit there; a `guest` without a row gets 403, which is correct.

---

## 8. SPA

`usePermissions()` is rewritten, not extended:

```ts
const { can, orgRole } = usePermissions();
can("agents:write"); // current space's `permissions` ∪ current org's `permissions`
```

There are no `isOwner` / `isAdmin` / `isMember` helpers: every gate is a `can(...)` on the permission the server actually checks for that action. The org-settings layout hides a tab when the caller holds none of the tab's permissions; the space switcher lists only `access: "member"` spaces (`closed` ones appear disabled with a "request access" hint, `private` ones do not appear); `RunAgentButton` renders on `agents:run`.

The UI separates organization administration from sharing a space:

- **Org settings → Users** is the central list of all organization accounts, including guests. Its invitation button opens a modal for a standard user, an administrator or a guest (a guest invitation requires at least one space assignment); onboarding offers only the first two. Onboarding uses the same invitation form inline with those two roles. Pending invitations can be edited in a modal, including changing a role to guest and assigning the required spaces; they remain pending until acceptance.
- **Space settings → Members** shows each user's implicit or explicit access (§6.4) in an Access column named by its source — assigned, open space, organization role — and, for an organization role, the role itself qualified by its scope ("Owner of the organization"), while the space `admin` preset is labelled "Space admin" everywhere so the two administrators never share a word. Adding an existing organization user uses the member selector when the caller can read the organization directory, or exact email otherwise. A separate option to invite someone new appears only with the organization permission `members:invite`: it creates a pending guest invitation with the current space and selected space role. The confirmation offers the invitation link and a link to manage pending invitations in the central Users page. The same page lists, under the members, the pending invitations whose assignments include this space — the same rows the Users page shows, never a fake member — with edit, copy-link and cancel. One pending invitation exists per (organization, email): a second invite for a pending address is refused with 409 `invitation_already_pending` (partial unique index `uq_org_invitations_pending`, 0056 §H) and the form points to the existing invitation's editor, so adding a second space extends one invitation instead of silently replacing the first and invalidating its link. A guest space administrator can add existing organization users but cannot create an organization invitation without that organization permission.
- **Org settings → Roles** displays read-only presets and custom-role administration when `features.custom_roles` is enabled. The custom-role editor loads `GET /api/roles/vocabulary`, supports searching permissions and reports loading failures. Role/default selectors load the grantable catalog for the target space; a failed catalog cannot silently substitute a grantable role.
- **Role preview** ("view as", §6.7) is entered from two places, both visible only to an owner or an administrator (`useCanPreviewRole()`): a **Prévisualiser un rôle** action at the top of Org settings → Roles and the same action beside "Ajouter un membre" on Space settings → Members. Both open one dialog (`components/view-as-dialog.tsx`) — the org role as described radio options, the space, and that space's grantable role catalog (`GET /api/spaces/:id/roles`, read with the caller's REAL permissions, before the preview starts). Space and role are optional as a pair, matching the header. Entering a persona with a space also makes that space the current one, since that is where its role applies. While a preview runs, a permanent warning banner above the page header names the persona and the space and carries the only exit; it is not dismissible. Elsewhere the persona is only its org role — an implicit member of open spaces with their `default_role` — and when the user is in such a space the banner appends the role effective there, read from the space listing (answered as the persona). Leaving, switching organization and losing the session all drop it, and so does a refusal (§6.7), with a translated reason.
- **OAuth organization-client create/edit** uses the shared space-assignment picker for signup policies (§7.2). Selected assignments remain visible when their space or role becomes unavailable, and the form requires repair before saving them. The same validation applies to organization invitations.

The Users page therefore lists guests without making organization-wide invitation the entry point for sharing a space. Organization and space headings use their respective context. Labels, role descriptions, errors and controls remain usable on narrow screens; resetting an explicit role in an open space explains the restored default access before confirmation. Invitation and OAuth signup forms keep the Spaces section visible but disabled for administrators, explaining their full access to all spaces. Switching back restores the draft selections; administrator requests still send no explicit assignments.

The space Members tab accepts either `space-members:read` or `space-members:invite`. An invite-only custom role can add an existing org user by exact email without fetching or rendering the member list.

The SPA's role strings are display only. `packages/shared-types/src/member-role-policy.ts` keeps the assignable-role logic for the org tab. `ASSIGNABLE_ORG_ROLES = ["guest", "member", "admin"]`.

`features` reaches the SPA as it does for `billing` (`apps/web/src/components/sidebar-billing.tsx`).

---

## 9. OSS / EE boundary

|                                                                    | OSS (Apache-2.0, core)  | Provided by a module                                                                  |
| ------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| org roles, `guest`                                                 | ✅                      |                                                                                       |
| `space_members`, visibility, presets, resolver, routes             | ✅                      |                                                                                       |
| `space_roles` table, validator, `GET /api/roles`, vocabulary route | ✅                      |                                                                                       |
| `POST/PATCH/DELETE /api/roles`                                     | code in core, **gated** | `features.custom_roles: true` — set by `module-ee`; any EE-licensed module can set it |
| billing managers, billing contact, `billing:*`                     |                         | `module-ee` (§10)                                                                     |
| `principalPermissions` hook                                        | contract in core        | any module                                                                            |

Core keeps its zero-billing-vocabulary invariant: the Apache-2.0 core (`apps/api/src`, `packages/*` except `module-ee`) declares no `billing` role, no billing column, no billing permission, no billing route and no billing env var. The SERVED OpenAPI spec and the generated SPA types (`apps/web/src/api/schema.d.ts`) do carry the ee module's contributions (`/api/billing*`, `Ee*` schemas), the same way they carry every in-tree module's, and the SPA renders them only when the server reports `features.billing`.

---

## 10. Billing (`@appstrate/module-ee`)

Two concepts, deliberately separate:

**Billing managers** — org users who may act on billing without being admins. Module table `ee_billing_managers(org_id, user_id, added_by, created_at)`, migrated into the platform database by the module itself, managed at `PUT /api/billing/managers` (`billing:manage`), listed in the billing page. The module grants them `billing:read` + `billing:manage` through `principalPermissions` (§4.2) with `mayGrant: ["billing:read", "billing:manage"]`. Role grants stay: `billing:read` → owner/admin/member (a guest does not see the plan), `billing:manage` → owner/admin. GitHub's billing manager, without the enum.

**Billing contact** — where invoices, receipts and payment alerts go.

```sql
ALTER TABLE ee_billing_accounts
  ADD COLUMN billing_email text,                       -- NULL = fall back (below)
  ADD COLUMN billing_cc    text[] NOT NULL DEFAULT '{}';
```

- `PATCH /api/billing/contact` (`billing:manage`) sets both; each address validated; CC capped at 5.
- Stripe: `customers.create({ email: contact, metadata })` at checkout — `packages/module-ee/src/stripe/checkout.ts` sets no `email`, so Stripe holds no address of its own, and `customers.update` when the contact changes. Stripe then addresses its own receipts correctly; the Dashboard-only "additional recipients" feature is not relied on.
- `sendBillingEmail` recipients = `billing_email ?? emails of org owners` ∪ `billing_cc` ∪ emails of billing managers. `getOrgAdminEmails` (fan-out to every admin) is deleted from the module contract, not kept as a fallback.
- Default at org creation: `billing_email = creator's email` — written by `onOrgCreate`, which already receives `userEmail` (`packages/module-ee/src/onboarding/post-signup.ts`).

The module's `permissionsContribution` entries gain `level: "org"` (§3.5). It depends on `@appstrate/core` as `workspace:*`, so the contract change and its consumer land in the same commit — there is no tag order and no version bump to sequence.

---

## 11. Migration

Doctrine: `NO_TRANSITIONAL_CODE.md`. Catalog changes are drizzle migrations; row rewrites are `scripts/migration/`.

**Schema — `packages/db/drizzle/0056_space_roles.sql`:** `ALTER TYPE org_role ADD VALUE 'guest'`; `space_roles`, `space_members`; `spaces.visibility`/`default_role` + checks; `org_invitations.space_assignments`; `chat_sessions.space_id`; `oauth_clients.signup_space_assignments`. Two writes ride along, each licensed by a constraint the same file promotes on the same table (§2 of the doctrine): `chat_sessions.space_id` is backfilled to the org's default space, then `SET NOT NULL`; and OAuth clients whose `signup_role` reads `viewer` become `guest`, which is what lets `oauth_clients_signup_role_check` be re-added narrowed to `admin | member | guest`. The space grants those clients lose in that flip are rows, so they are captured by `scripts/migration/0008`, not here.

**Schema — `packages/db/drizzle/0056_space_roles.sql`, section H:** the partial unique index `uq_org_invitations_pending` on `(org_id, email) WHERE status = 'pending'`, which is what makes two concurrent invitation creates safe (§6.1). It can only fail on a pair of duplicates left by a race under earlier code; `scripts/migration/0009` is the conditional pre-flight that clears them.

**Rows — `scripts/migration/0008-org-viewer-to-guest.sql`**, one transaction:

1. `INSERT INTO space_members (space_id, user_id, preset_role) SELECT s.id, m.user_id, 'viewer' FROM org_members m JOIN spaces s ON s.org_id = m.org_id WHERE m.role = 'viewer'`
2. `UPDATE org_members SET role = 'guest' WHERE role = 'viewer'`
3. Pending viewer invitations snapshot the same current-space viewer grants into `space_assignments`, preserving explicit choices, then become `guest`.
4. The OAuth clients `0056` flipped to `guest` take the identical snapshot into `signup_space_assignments` — a `guest` signup policy with no assignment provisions nobody.
5. Verification that **discriminates**: the counts of `org_members.role = 'viewer'` and of pending `viewer` invitations must both be 0 **and** every pre-flip (user, space) pair must be covered by a `space_members` row, and every captured invitation and client must carry its snapshot — printed before and after, and raised on rather than returned. Acceptance and signup retain their former reach; spaces created later never enter the snapshot, including after a rerun.

Between `0056` and `0008` a member whose row still reads `viewer` resolves no permission set and its requests fail; the two are one maintenance window, not two deploys. Rollback is one-way from `0056`: the previous build inserts `chat_sessions` without `space_id`, which is now NOT NULL.

**Rows — `scripts/migration/0012-org-invitation-history-viewer-to-guest.sql`:** the invitations `0008` deliberately leaves alone. `0008` restricts its invitation UPDATE to `status = 'pending'`, because a pending row also gets the `space_assignments` snapshot its step 5 verifies; an accepted, expired or cancelled one grants nothing and needs none. That leaves them as history reading `viewer`, which `0059` cannot cast — so `0012` maps them to `guest`, the successor `0008` chose for the same offers, and keeps `status <> 'pending'` as a load-bearing scope rather than a tidy one: a pending row swallowed there would lose its snapshot and become invisible to `0008` on a rerun.

**Schema — `packages/db/drizzle/0059_drop_org_viewer.sql`:** `ALTER TYPE … DROP VALUE` exists in no released PostgreSQL, so `0056` can add `guest` but cannot remove `viewer`; `0059` recreates the type as `('owner','admin','member','guest')`, moves `org_members.role` and `org_invitations.role` onto it, and drops the old one. No data write. Its section A refuses the deploy while any row still reads `viewer`, counting each set and naming the script that clears it.

**Whether `0059` ships with `0056` or one release later is a property of the database, not of the change.** Nothing can run between the two inside one release — drizzle applies the pending batch in one transaction and the row scripts run after it — and `0008` must READ `viewer` to compute the `space_members` rows that preserve those users' reach, which it cannot do before `0056` creates that table. So a database holding `viewer` rows needs two releases, with `0008` and `0012` in the gap. A database holding none gives `0008` and `0012` nothing to do, section A reads four zeros, and the migrations apply as one batch. Step 3 of the runbook is the query that decides, and section A is what makes guessing wrong safe: it fails the deploy rather than casting rows it cannot preserve.

The Drizzle snapshot includes the OAuth assignment column and matches the schema generator (`db:generate` reports no changes). Migration tests replay the OAuth rewrite and the invitation migration, including real invitation acceptance.

**The runbook for this change is `scripts/migration/README.md` → RBAC rollout**, and it is the only copy of THAT one: rehearsal on a restored dump, the duplicate-pair pre-flight that decides whether `0009` runs, the order of the five files, which release each belongs to, and what to verify after each. Each migration file's own header is the authority on what it touches and what it deliberately leaves alone.

**Schema + rows — personal spaces and sharing (`0061`, `0062`, `0063`, scripts `0013` + `0014`):** `packages.home_space_id` (§6.9), `spaces.owner_user_id` / `orphaned_at` (§3.6) and the `package_shares` table (§6.10). One release, three migrations in one boot batch, and two scripts on opposite sides of the window: `0013` gives every existing package a home and is NOT optional — until it runs, every row reads `home_space_id IS NULL`, i.e. the organization catalogue, so every non-owner author and every API key is locked out of its own packages, which is why it runs with traffic stopped (the `0008` shape). `0014` provisions the personal spaces of members who already exist and IS optional forever: `provisionMember` creates them at every membership door and `GET /api/spaces` repairs the caller's own. `0062` is one-way from the FIRST BOOT of the new build rather than from `0014` — personal spaces exist from the first request served, and an older build's resolver reads one as an ordinary `private` space and hands every organization admin `admin` in it. **The runbook is `scripts/migration/README.md` → "Personal spaces & sharing rollout"**: the ambiguity pre-flight for `0013`, what the two new `ON DELETE RESTRICT` edges make undeletable, the order, what to validate after the deploy, and the per-file rollback truth.

---

## 12. Follow-ups

- **Extending a pending invitation from a space form.** One pending invitation exists per (organization, email), so a second invite for a pending address is refused with 409 `invitation_already_pending` and the administrator edits the existing invitation to add a space (§6.1, §8). Adding the space atomically from the space form would spare that round trip; a frontend read followed by a whole-list `PUT` is not a concurrency-safe merge and is not the shape to build.

---

## 13. Considered and rejected

### 13.1 Better Auth `organization` plugin (dynamic access control + teams)

It has runtime roles (`organizationRole` table, `createRole`, comma-separated roles on `member.role`) and teams (`team`, `teamMember`). Rejected: teams carry **no per-team role or permission** — `hasPermission` is org-level and ignores the active team — so the one thing this spec needs is the one thing the plugin does not do. Adopting it would also replace `org_members`/`org_invitations` and the hand-rolled API keys for no gain. Better Auth stays the identity provider.

### 13.2 Scope + resource selection ("`agents:read` on these three agents")

Per-resource ACL is ReBAC territory (Zanzibar / OpenFGA / WorkOS FGA): a tuple store, a check API, list-filtering in every query, and a UI to share each thing. Notion does this at page level and it is most of Notion. Rejected; the model here keeps that door open in one specific way — `effective(space)` is computed per request from a resolver, so a later per-resource layer would be a second predicate in the same place, not a rewrite.

The real cost of "space = access unit" is that hiding one agent means a new space, and `integration_connections` are per space, so splitting a space duplicates connections. If that bites, the cheap next step is a `visibility: "private"` flag on a package (creator-only, filtered in SQL like `actorScopeFilter` filters runs), not an ACL.

### 13.3 Presets as seeded rows per org

One list for the UI and an FK for everything. Rejected: every new space-level permission would need a `scripts/migration/` rewrite of N×orgs rows to reach the right preset, where a constant reaches it in the same commit. The two-column `space_members` shape keeps DB enforcement for both kinds.

### 13.4 Keeping an org-level `viewer`

Vercel keeps a free team-level Viewer. Rejected: with space roles, "read everything" is `member` + a `viewer` default on open spaces, and "read only these" is `guest` + `viewer` rows. A fifth org role would exist to save an admin one setting.

### 13.5 `billing` as an org role

The obvious SOTA shape (Vercel, GitHub). Rejected on the Apache-2.0 boundary: the `org_role` enum is core, and a `billing` value there is billing vocabulary in OSS. `principalPermissions` gives `module-ee` the same outcome and is reusable — SSO group → permission mapping is the next candidate for it.

### 13.6 Space-level custom roles editable by space admins

Notion lets teamspace owners set defaults; nobody lets a sub-container admin define permission bundles. A definer who does not hold every permission needs a ceiling check on every edit; org admins hold everything, so restricting definition to them removes the problem instead of solving it.
