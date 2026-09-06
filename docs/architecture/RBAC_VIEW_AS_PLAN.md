# View as role — plan

Status: **phase 1 (server contract) implemented**, 2026-09-06. Builds on the RBAC model of PR #1260 (`RBAC_PERMISSIONS_SPEC.md`). §5 and §7 describe shipped code (`apps/api/src/lib/view-as.ts`); §6 (SPA) and §8's phases 2-3 are still proposals.

## 1. Goal and non-goals

**Goal.** An organization owner or administrator can see and use the product as a chosen _persona_ — an organization role, optionally with a space role in one space — to check what a role actually reaches before assigning it. The check must be true: what the persona cannot do, the previewing admin cannot do either, on every API call, for as long as the preview is on.

**Non-goals.**

- Impersonating a specific user (Salesforce "Login As", django-hijack). Different threat model, different audit story, and not needed to validate a role. Left for a later decision; §9 says what would carry over.
- Previewing a credential (an API key's scopes, an OIDC token). The ceiling mechanism already exists for those; a key's reach is inspectable from its scopes.
- A client-only preview that hides controls while the API keeps answering with admin authority. Airtable's community reports show exactly that failure mode: the preview "at times uses the permissions of the actually logged in user".

## 2. What comparable products do

| Product                              | Shape                                                                                                                                                    | What to keep                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| WordPress _View Admin As_            | Switch to a role or a user; "temporarily change your own capabilities (non-destructively)"; the real account keeps its capabilities; reset from the bar. | Role preview as a downgrade of one's own capabilities; one visible exit; refuses to switch to an equal role.                     |
| Retool                               | Preview mode of an app; access is checked by permission groups, sharing is tested with a viewer link or by group membership.                             | Preview is a first-class mode of the editor, entered and left from the toolbar.                                                  |
| Airtable Interface Designer          | "Preview" / "View as" before sharing an interface; known to leak the creator's permissions in places.                                                    | The counter-example: a preview the server does not enforce is misleading.                                                        |
| Facebook _View As_ (2018)            | Profile preview; three bugs combined so that a video uploader minted an access token **for the viewed user**; 30M tokens stolen; feature turned off.     | Never mint or switch credentials for the preview. The persona must be a pure restriction computed from the caller's own session. |
| Salesforce _Login As_, django-hijack | Full impersonation; audit trail, a banner, "observe then get out", advice not to write data while impersonating.                                         | Banner and audit are non-negotiable even for role preview; the write policy is a decision (§4.6).                                |

Sources: [WordPress plugin page](https://wordpress.org/plugins/view-admin-as/), [Retool app sharing](https://docs.retool.com/apps/guides/app-management/share), [Airtable interface sharing](https://support.airtable.com/docs/managing-and-sharing-interfaces) and a [community report](https://community.airtable.com/interface-designer-12/interface-is-not-allowing-collaborator-to-add-new-item-to-single-select-field-38458), [Meta's incident update](https://about.fb.com/news/2018/10/update-on-security-issue/), [django-hijack](https://github.com/django-hijack/django-hijack), [Salesforce login-as audit note](https://help.salesforce.com/s/articleView?id=000386521&type=1&language=en_US).

## 3. Decisions

1. **Persona, not user.** A preview is `{ org_role, space?: { space_id, role } }` where `org_role ∈ { member, guest }` and `role` is a preset or a custom role id. It answers "what does a standard user with `viewer` in Marketing see", which is the question a role editor has. Previewing `admin` or `owner` is refused: nothing to learn, and it keeps the rule "a preview only removes".
2. **Server-enforced, in the existing pipeline.** The persona is carried by one request header and applied where permissions are already computed: the auth pipeline (org set), `orgPathContext` (the `/api/orgs/:orgId*` family), `applySpacePermissions` (space slice), and the two listings the SPA derives its gates from (`GET /api/orgs`, `GET /api/spaces`). The SPA changes nothing in how it gates: `can()` keeps reading the permissions the server returns.
3. **Restriction only, and only the ORG half is an intersection.** The org set is `orgPermissions(persona) ∩ real`, because `grantTo` carries no nesting rule: a module may grant an org-level permission to `member` and not to `owner`, and the previewing owner must not gain it. The SPACE slice is `spacePermissions(ref)` with no intersection, because it is a subset of the previewer's by construction — presets are upward-closed (core's table, and `assertPresetsUpwardClosed` holds module contributions to it), eligibility is owner/admin whose real standing in every space is preset `admin`, and a custom bundle is checked grantable at validation. That is a structural guarantee, not a check, and it is exactly what widening eligibility below org admin (§9) breaks: doing so must reintroduce a space-half intersection AND read the previewer's real `space_members` row, since a space admin's standing no longer follows from their org role.
4. **Eligible callers: session-shaped owners and admins.** Cookie sessions and `deferOrgResolution` strategies (the CLI acting as the user), real org role `owner` or `admin`. API keys, OIDC tokens, MCP bearers and end-user tokens carrying the header get `400 view_as_unsupported`. Anyone else eligible-by-transport but not owner/admin gets `403 view_as_forbidden`. Both are refusals of the request, never a silent fall-back to the real permissions.
5. **The real identity stays the actor.** `c.get("user")` and `c.get("orgRole")` are untouched; `permissions`, `orgPermissions` and `spaceRole` are the persona's. Audit rows keep `actor_id` = the admin and add the persona (§5.4). Handlers that read `orgRole` for who-manages-whom policies run after a permission guard the persona already narrowed, so they cannot be reached with an authority the persona lacks; a handler that could act on `orgRole` without a guard is a bug this plan's tests must surface (§7).
6. **Visible and one click from over.** A persistent banner names the persona and the space, offers "Quitter", and the preview is dropped on org switch, on sign-out, and on reload only if the persisted persona is still valid (space still exists, role still grantable) — otherwise it is discarded with a toast, never silently kept.
7. **Writes are allowed under the persona's permissions.** Blocking mutations would make "can this role run an agent" untestable, which is the main reason to preview. The persona is a strict downgrade, the audit row names it, and the banner is permanent, so a write under preview is a write the persona could do, done by an admin who said so. Reviewed in §4.6.
8. **OSS, no feature flag.** Role preview needs nothing from cloud. Custom roles stay behind `features.custom_roles`; previewing a preset works everywhere.

## 4. Contract

### 4.1 Header

```
X-View-As: org_role=member; space=spc_01hx…; role=preset:viewer
X-View-As: org_role=guest; space=spc_01hx…; role=custom:role_01hx…
X-View-As: org_role=member
```

- `org_role` required, `member | guest`.
- `space` and `role` optional but paired; `role` is `preset:<admin|builder|operator|viewer>` or `custom:<id>`.
- Parsed by a strict Zod schema; anything else is `400 invalid_view_as`. Both ids are shape-checked there (`spc_`, `srl_`), so a malformed one points at the header rather than at a field the caller never sent.
- One header, not three: the persona is one value the SPA stores and the server validates as a whole.
- Sent by the SPA through `buildScopingHeaders()` next to `X-Org-Id` / `X-Space-Id`.

**Two carriers that are not the header**, same grammar and same validation:

- **SSE** (`/api/realtime/*`) takes it as the `view_as` QUERY parameter — and refuses the header there with `400 invalid_view_as`, since a header on a route `EventSource` reaches is a client bug, not a persona to honour. Those routes are exempt from the auth pipeline (`skipAuth`) and their browser client is an `EventSource`, which cannot send headers at all — a header-only contract would have left the whole realtime surface answering with the caller's real authority. Cookie sessions only: `?token=ask_…` with `view_as` is `400 view_as_unsupported`. A stream refused under a persona answers `403 not_a_space_member` / `404` (the persona's wall) rather than the header-less path's `401`.
- **The chat module's in-process loopback** carries the persona inside its HMAC-signed claims (`packages/module-chat/src/loopback-auth.ts`). The re-entered request has no header of its own, so without this the engine's `/api/mcp/o/:org` tool calls would run with the caller's real authority while the browser showed a preview. The snapshot is ADOPTED, not re-validated (`adoptViewAs`): the claims are as trustworthy as `claims.permissions`, which the strategy already carries verbatim, and the hop's own ceiling is the persona's set — re-checking grantability against it would refuse every persona that is not an admin of its space. The bearer is also minted with the persona's org role, so a snapshot lost in transit fails closed.

### 4.2 Validation, per request

Order matters; each step is a refusal, never a fall-back.

1. Transport eligible? Session or `deferOrgResolution`; otherwise `400 view_as_unsupported`.
2. Real org role `owner | admin`? Otherwise `403 view_as_forbidden`. Audited as a permission denial (`reportPermissionDenial`) so abuse is visible.
3. `space` belongs to the org (`validateSpaceInOrg`); otherwise `404`.
4. `role` grantable by the real caller in that space (`canGrantSpaceRole(realPermissions, ref)`); a custom role must exist in the org and be grantable; otherwise `403 view_as_forbidden`.
5. Custom role while `features.custom_roles` is off: `403`, same answer as assigning it. Checked BEFORE step 4's existence lookup — where the feature is off the deployment has no bundle vocabulary at all, so "does this id exist" is not a question worth answering.

The parsed persona is written to `c.set("viewAs", persona)` before any permission write.

**A persona belongs to one organization.** It carries the `orgId` it was validated in and the caller's REAL org role there, and every apply site asks for the org it is answering about (`personaFor(c, orgId)`). A request that resolves a SECOND org — forking a package out of another org the caller really belongs to — sees their real role and real `space_members` rows there. Carrying the real role on the persona is also what keeps the `∩ real` narrowing correct across the loopback hop, where the request's own org role IS the persona's.

**The two org listings refuse rather than no-op.** `GET /api/orgs` and `GET /api/me/orgs` are exempt from `requireOrgContext`, so the previewed org is named by `X-Org-Id`: the header with no org id is `400 invalid_view_as`, and an org the caller is not a member of is `404`. Answering those with real permissions while the client believed it was previewing is the failure this feature exists to prevent.

### 4.3 Resolution

Persona resolution reuses the real resolvers with the persona's inputs:

- **Org set.** `orgPermissions(persona.org_role)` — no principal grants (a module's per-user grant such as billing is an attribute of the admin, not of the persona), then `∩ real`. Written to `orgPermissions` and `permissions` exactly where `applyOrgPermissions` and `orgPathContext` write them today.
- **Space slice.** In `applySpacePermissions`, the member row is replaced by the persona overlay: `resolveSpaceRole(persona.org_role, space, overlay)` where `overlay` is `{ ref }` when `space.id === persona.space.space_id`, else `null`. Owners and admins never have `space_members` rows (the write refuses them), so there is no real row to ignore. A `null` result keeps today's outcome: `403 not_a_space_member` for open/closed, `404` for private — the preview shows the persona's wall, which is the point.
- **Listings.** `GET /api/spaces` calls `listSpacesForPrincipal` with the persona's org role and the overlay instead of the caller's memberships, so `access`, `role`, `permissions` and visibility filtering are the persona's. `GET /api/orgs` and `GET /api/me/orgs` report the persona's `role` and permissions for the previewed org only.
- **Roles catalog.** `GET /api/spaces/:id/roles` under preview answers with the persona's permissions like any other route; the SPA's "preview as" picker reads the catalog **before** entering preview and keeps it (§6.2).

### 4.4 Response marker

Every response produced under a validated persona carries `X-View-As-Active: 1`. The SPA does not need it to render — the banner comes from its own store — but the CLI and any hand-rolled caller can tell that a 403 was the persona's, and a test can assert that a request without the header never carries the marker.

### 4.5 Errors

| Code                  | Status | When                                             |
| --------------------- | ------ | ------------------------------------------------ |
| `invalid_view_as`     | 400    | Header does not parse                            |
| `view_as_unsupported` | 400    | Transport is not session-shaped                  |
| `view_as_forbidden`   | 403    | Real role not owner/admin, or role not grantable |
| `not_found`           | 404    | Space not in org, custom role not in org         |

Documented in OpenAPI as a shared `components.parameters.XViewAs` header on every authenticated operation and a shared `ViewAsRefused` response, so the baseline diff is one component plus references.

### 4.6 Writes under preview

Allowed (decision 7). Two guards make it safe to leave allowed:

- The persona is applied before every permission guard, so a write the persona lacks is `403` like for the real user of that role.
- Audit rows record the persona (§5.4), and the audit log UI shows "as `viewer` in Marketing" next to the actor.

If, after use, writes under preview turn out to confuse more than they help, the switch is one condition in the header validation (`method !== GET/HEAD → 405 view_as_read_only`), not a redesign.

## 5. Server work

### 5.1 Parse and validate — `apps/api/src/lib/view-as.ts` (new)

`parseViewAs(header) → Persona | null` (Zod), `assertViewAsEligible(c, persona)` (steps 1–5 of §4.2). Called from one place: a middleware mounted right after org resolution and before the permission step, for both the header-org path (`requireOrgContext`) and the path-org path (`orgPathContext`), so the persona is known before any `permissions` write.

### 5.2 Apply — three existing write sites

- `auth-pipeline.ts` `applyOrgPermissions`: when `c.get("viewAs")` is set, compute `orgPermissions(persona.org_role) ∩ real` instead of `role ∪ principal`. Same function, one branch, so the three auth branches cannot diverge.
- `org-path-context.ts`: same branch at its single `permissions` write.
- `space-context.ts` `applySpacePermissions`: overlay instead of `loadSpaceMember` when `viewAs.space` names this space; `null` row otherwise.

### 5.3 Listings

- `services/spaces.ts` `listSpacesForPrincipal(orgId, orgRole, userId, overlay?)`: with an overlay the memberships map is `{ [overlay.spaceId]: overlay.row }`.
- `routes/organizations.ts` list + `routes/me.ts`: `role` and `permissions` come from the persona for the previewed org.

### 5.4 Audit

`audit_events` gains nothing: `recordAuditFromContext` merges `{ view_as: persona }` into `after` when a persona is set (the column is a free-form jsonb already). The permission-denial audit (`lib/permission-audit.ts`) does the same — beside the REAL `role`, so a trail can still tell an abuse attempt from a preview. No migration.

### 5.5 What is deliberately not touched

- Run tokens and sidecar credentials: a run started under preview runs with the run's own server-minted credentials, unchanged. The preview restricts the admin's session, not the agents they start.
- The MCP in-process re-entry is NOT in this list any more, on either of its two doors. The inbound `/api/mcp/o/:org` endpoint forwards `x-view-as` onto every dispatch (`FORWARDED_AUTH_HEADERS`, `modules/mcp/tools.ts` — and `PROTECTED_HEADERS` is derived from that set, so the model cannot reshape it); the chat engine reaches the same re-entry over the module's loopback bearer, which carries the persona in its signed claims (§4.1). Either way a tool call under preview reaches exactly what the previewed role reaches. What stays untouched is the run the call may launch.
- `c.get("orgRole")`: stays real. §7 lists the test that proves no unguarded handler acts on it.

## 6. Web work

### 6.1 State and transport

- `stores/view-as-store.ts`: persisted per org (`appstrate_view_as:<orgId>`), holds the persona plus the labels the banner shows (role name, space name) captured at entry time.
- `lib/scoping-headers.ts` `buildScopingHeaders()`: adds `X-View-As` when the store holds a persona for the current org. Every fetch path already goes through it.
- Entering or leaving the preview calls `queryClient.clear()` (the pattern `nav-user.tsx` uses on sign-out), so no admin-shaped data survives in the cache.

### 6.2 Entry points

- **Org settings → Roles**: a "Prévisualiser" action per role opens a small dialog: org role (Utilisateur standard / Invité, radio with descriptions, same component as the invitation form) and the space to apply the role in (default: current space). Presets and custom roles alike.
- **Space settings → Members**: same dialog from a "Voir en tant que…" button next to "Ajouter un membre", pre-filled with the current space.
- The dialog reads `GET /api/spaces/:id/roles` with the real permissions and only offers grantable roles, mirroring the server's step 4.

### 6.3 Banner

Persistent, above the page header, in both the app shell and settings layouts: "Vous voyez l'organisation en tant que **Utilisateur standard**, **Lecteur** dans **Marketing** — Quitter". Visible on every route, including error pages: a 403 under preview must be readable as the persona's.

### 6.4 Exit and invalidation

- "Quitter", org switch, sign-out: clear the store and the query cache.
- On load with a persisted persona: the first `GET /api/orgs` either succeeds (preview resumes) or fails with a `view_as_*` code (space deleted, role removed, caller demoted); the SPA then drops the persona, clears the cache, and toasts "Prévisualisation arrêtée : …". It never retries without the header silently.

## 7. Tests that discriminate

Integration (`apps/api/test/integration/…/view-as.test.ts`):

1. Owner previews `member` + `viewer` in the default space: `GET /api/spaces` shows `role.viewer`, `permissions` without `agents:write`; `POST /api/agents` → 403; the same POST without the header → 201. Both halves in one test.
2. Owner previews `guest` with no space: `GET /api/spaces` is empty; a space-scoped route with `X-Space-Id` → `403 not_a_space_member`; a private space → 404.
3. Persona never elevates: a custom role granting `space-settings:write` previewed by an admin whose real ceiling (OIDC dashboard token, session-shaped) lacks it → the permission is absent.
4. Refusals: member caller → 403 `view_as_forbidden` and an audit denial row; API key → 400 `view_as_unsupported`; malformed header → 400; role not grantable → 403; space in another org → 404.
5. Audit: an action under preview writes `after.view_as` with the persona and `actor_id` = the admin.
6. `orgRole` sweep: the test greps `apps/api/src` AND `packages/*/src` for `.get("orgRole")` and holds the file set against an allowlist carrying a one-line justification each, so a new reader fails until it is reviewed against the persona. Paired with behavioural tests for the sites where `orgRole` drives a who-manages-whom policy (org member role change/removal, space create/delete, the package catalog): under persona `member` each is refused or answers as a member would.
7. Marker: `X-View-As-Active` present exactly when the header validated.

Web (bun test, no DOM): banner renders from the store; `buildScopingHeaders()` emits the header only for the matching org; the roles dialog offers grantable roles only.

E2E (`e2e/tests/rbac/view-as.ui.spec.ts`): owner enters preview as `viewer` from the Roles page → the Run button is gone, the agent editor is read-only, the banner shows; "Quitter" restores the Run button; reload keeps the preview; deleting the previewed custom role from another context then reloading ends the preview with the toast.

## 8. Delivery

Three PRs, each shippable:

1. **Server contract** — `view-as.ts`, the three apply sites, listings, audit, OpenAPI, integration tests 1–7. No UI. The CLI can already use it with a flag for scripting checks.
2. **SPA** — store, header, banner, exit rules, web tests, e2e on presets.
3. **Entry points** — Roles page and Members page dialogs, custom roles, docs (`RBAC_PERMISSIONS_SPEC.md` §4.2 gains the `viewAs` key in the pipeline table; §6 gains the header and errors).

Order is fixed: nothing in 2 or 3 is safe to merge before 1, because a client-side preview without the server contract is the Airtable failure.

## 9. Open questions

- **Preview an org role alone from the org pages?** Decision 1 allows `org_role` without a space; the entry points in §6.2 always ask for a space. Keeping the space optional in the contract costs nothing and lets the CLI answer "what does a guest with no assignment see" (nothing).
- **Eligibility below org admin.** A space `admin` (preset) previewing `viewer` in their own space is the natural next step for delegated administration. The contract supports it (step 4 already checks grantability); decision 4 restricts to owner/admin for the first release so that the "never elevate" property is trivially true. Widening is a one-line change in step 2 plus tests.
- **Impersonation later.** If "view as user X" is ever wanted, the persona becomes `{ user_id }`, resolution reads X's real membership rows, and everything else (header, banner, audit, marker, refusals) is reused. What would be new is the policy: consent, notification to X, and no writes.
