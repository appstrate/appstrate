# Permission-aware MCP surface

The platform MCP server (`apps/api/src/modules/mcp`) and the chat built on it
show every caller the same tools, the same operation search and the same
operation descriptions, whatever the caller's RBAC set. Only two spots already
follow the caller's grants: `run_and_wait`'s `kind:"inline"` (PR #1481) and the
operation index in the server instructions, filtered per OpenAPI **tag** through
a hand-kept `TAG_TO_RESOURCE` map. This plan makes the whole surface derive from
the one thing that already knows the answer — the permission guards mounted on
the routes — and deletes the hand-kept map.

## Rule

**Enforce once, inform twice.** Authorization is decided by the route guard,
nowhere else. What the model is shown is derived from the same guards:

1. An act the caller's set makes **structurally impossible** — a whole tool,
   an enum value, an argument — is **absent** from what the model sees: not
   declared, not indexed, not taught.
2. An act that depends on the **row** (file ACL, `draft_not_writable`,
   home-space authority, personal-space owner) stays visible and is described as
   conditional. Hiding it would hide the page that explains the refusal.
3. A refusal names the permission it needed. The model reports it; it never
   retries.

Nothing in this plan removes a guard, adds a second decision point, or lets
metadata refuse a call. Filtering is context reduction and honesty, not a
security boundary — the boundary stays the guard.

## Decisions

Each one was checked against what the field does and what this repository
already commits to.

| #   | Question                                                                                                                                  | Decision                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Refuse in `invoke_operation` before dispatch when the catalog says the caller lacks the permission?                                       | **No.** Always dispatch; on a `403` from the route, enrich the tool result with the operation's required permissions and a "do not retry, tell the user" note.                                                                                                                                                                                                   | One enforcement point (RBAC spec §4.3: audit on denial, once — the guard fires it, `permission-audit.ts` logs it). A pre-dispatch refusal would be a second copy of the policy that could refuse what the route allows (row-conditional ops). The MCP spec puts an authorization refusal at the resource, surfaced as an `isError` tool result the model can act on.                                                                                                                                                                                                                                      |
| 2   | `search_operations`: drop denied operations or mark them?                                                                                 | **Index drops, search marks.** The index (always in context) lists only granted operations. A search — the model asking on purpose — answers `operations` (granted, ranked) plus a compact `denied` list of ids with the permissions they need; `best_match` comes from the granted set only. `describe_operation` carries `required_permissions` and `granted`. | The prompt doctrine is "instructions for an act the token lacks are absent rather than contradicted" — that is the index. A search is a question, and "no such operation" would be a lie to a user asking "can you delete X?"; "needs `agents:delete`, which your role lacks" is the honest answer and lets the user fix their role. GitHub's server hides for classic PATs and shows-then-refuses for fine-grained ones; gateways (LiteLLM, Bifrost) filter at list AND enforce at call. Both halves here.                                                                                               |
| 3   | Where do the chat access chip's predicates live?                                                                                          | **In `@appstrate/core/permissions`, shared.** `canReadRuns` moves from `apps/api/lib/run-visibility.ts` to core beside `canComposeInline`; `canRunAgents` joins them. The MCP tool declarations, the chat prompt and the web chip call the same functions. No new endpoint.                                                                                      | The repository's pattern for "what THIS caller may do" is a server-computed predicate typed once (`home_writable`, `home_deletable`, `canComposeInline`), the same shape Google Drive `capabilities` and GitHub `permissions` use. The chip today re-implements `canReadRuns` by hand ("mirrors server-side") — the drift this plan removes. A verdict endpoint would add a round-trip to carry booleans the client can compute from the permission set it already holds; rejected as YAGNI. `maySetPackageActive` stays in the web: it reads a `SpaceGrant`, a UI shape, and no MCP tool declares on it. |
| 4   | Generalise the agent-authoring toggle into other per-turn narrowings?                                                                     | **No.** `turnPermissions` stays as it is: it can only remove `agents:write`.                                                                                                                                                                                                                                                                                     | Nobody asked for another one. The mechanism (narrow the turn's token, let every surface follow the set) already generalises at zero cost the day one is wanted; adding switches now is speculation.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | Per-call evaluation / approval ("ask" mode, Managed Agents `auto`)?                                                                       | **Out of scope.** Recorded as a non-goal.                                                                                                                                                                                                                                                                                                                        | Different problem (risk of a specific call) from this one (what the caller may do at all). The narrowed-token pattern is the seam it would plug into later.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | Declare permissions in the OpenAPI document (`x-permissions` per operation, or `security` scopes) or derive them from the mounted guards? | **Derive.** The guard factories stamp the requirement they check; the catalog reads it off Hono's route table.                                                                                                                                                                                                                                                   | `handler-marker.ts` states the doctrine: a hand-maintained list drifts away from the mounts silently, a marker carried by the middleware cannot. 243 operations declared twice (route and spec) is that drift by construction. The route table already proves "guard before lookup" (`agent-lookup-permission-order.test.ts`); this is the same read, one property richer. OpenAPI-to-MCP gateways derive tool scopes from the spec because the spec is all they have; here the code is the source.                                                                                                       |

## Design

### Guards carry what they require

`makePermissionGuard(required)` (`packages/core/src/permissions.ts`) already
stamps `Symbol.for("appstrate.permissionGuard")` = `true`. It additionally
stamps `Symbol.for("appstrate.permissionRequirement")` = `required` — the
string it will call `Set.has` on. `requireAnyPermission(["a","b"])` stamps
`"a|b"`, the form its audit already records. `requirePackageInOrg` and every
other row-aware guard keep the boolean marker only: they mean "conditional".

Core bump: `11.1.0` (additive, published before the consumer-facing PR; the
lockstep gate reads `connect-helper` only).

### The route table answers what a route requires

New `apps/api/src/lib/route-requirements.ts`:

```ts
export interface RouteRequirement {
  /** Each entry is one guard: `"agents:write"` or a disjunction `"runs:read|runs:read-all"`. All must hold. */
  requirements: readonly string[];
  /** Guards mounted after a space re-scope: enforced in the space the path names. Shown, never filtered. */
  targetSpaceRequirements: readonly string[];
  /** The row, or the target space, decides: `requirements` is a lower bound. */
  conditional: boolean;
}
export function deriveRouteRequirements(routes: Hono["routes"]): RouteRequirementLookup;
export function isGranted(requirement: RouteRequirement, permissions: ReadonlySet<string>): boolean;
```

`deriveRouteRequirements` answers a lookup function, not a map:
`(method, pathTemplate)` follows Hono's own matching — a prefix mount serves its
subtree — because several operations have no route of their own, and it answers
`undefined` when nothing serves. Hono's `:param` is rewritten to the OpenAPI
`{param}` form so the join with the catalog needs no second grammar. Handlers
are read through `findTargetHandler` exactly as `hasHandlerMarker` does.
`isGranted` tests `requirements` only — `every(r => r.split("|").some(has))`.

### Provenance, not just the permission

Two mounts mean something a permission string cannot say, so the derivation
reads both off the same table. A guard mounted behind `markSpaceRescope`
(`requireSpaceFromParam`, `routes/spaces.ts`) is enforced in the space the PATH
names, not the caller's: it lands in `targetSpaceRequirements`, is shown, and
never filters. A handler that decides on the row it loads declares `rowAuthority()`
(`middleware/require-permission.ts`), which sets `conditional` with no string.
Either one makes `requirements` a lower bound, which is what `conditional` means.

### The catalog joins on it

`CatalogOperation` gains one field, `requirement`. The join happens once, inside
`getCatalog()`: the catalog is itself built lazily on first use, after the module
routers have mounted, so the table it reads is complete (a boot-time derivation
would freeze a partial one). It reads the route table from `lib/platform-app.ts`
(a `getPlatformRoutes()` beside `dispatchInProcess`, throwing before
`setPlatformApp` like dispatch does — no fallback to "unfiltered"). An operation
the lookup cannot resolve does not become unfiltered: the build **fails**, naming
every offender. An operation with no guard on its route (health, `/api/me/*`,
uploads) has `requirements: []`, granted to everyone who reached the transport.
`/api/openapi.json` and `/api/docs` left the catalog: the spec's own source and
its human viewer are not operations a caller acts with.

`buildOperationIndex(permissions)` takes the permission set as a **required**
argument and filters **per operation** (`operationGranted`); a tag whose
operations are all denied has no section. `TAG_TO_RESOURCE` and `tagVisible`
are deleted in the same commit, and with them the unfiltered index and its
cache.

### Meta-tools declare what the caller may reach

`buildMcpTools` builds one table of what this caller is SHOWN, each row a
predicate over the same grants:

| Tool                                                                                                        | Declared when                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `search_operations`, `describe_operation`, `read_file`, `validate_package_file`, `get_runtime_capabilities` | always (read-only, transport gate `mcp:read`; `read_file` is a row)                  |
| `get_me`                                                                                                    | not `contextInjected` (unchanged)                                                    |
| `invoke_operation`                                                                                          | `mcp:invoke`                                                                         |
| `run_and_wait`                                                                                              | `mcp:invoke` ∧ `canRunAgents`; the inline half as today                              |
| `list_files`                                                                                                | the `listFiles` operation (`GET /api/files`) granted — its own guard, not a constant |
| `import_package_file`                                                                                       | unchanged (`canImportPackageFiles`)                                                  |

The in-handler checks (`mcp:invoke` in `invoke_operation`, `mcp:invoke` and
`canReadRuns` in `run_and_wait`) are **deleted**, not kept as defence in depth:
tools are registered per session, so a tool that was not declared is one the
SDK refuses with "Unknown tool" before any handler runs, and each of those
branches was unreachable by construction. Their telemetry goes with them — the
`"denied"` member of `McpInvokeOutcome` and the `mcp.operation.denied` audit
action are removed. A refusal is the route guard's own audit, once (RBAC spec
§4.3), which is the rule this plan started from.

### Search, describe, invoke

- `describe_operation` payload: `+ required_permissions: string[]`,
  `+ conditional: boolean`, `+ granted: boolean`.
- `search_operations`: `operations` holds granted matches; `denied` holds
  `{ operation_id, required_permissions }` for the rest (ids only, no
  summary); `best_match` only from `operations`.
- `invoke_operation`: unchanged before dispatch. When the response is `403` AND
  the caller's set does not clear the operation's caller-space requirements, the
  text result gains `required_permissions` (from the catalog) and one sentence:
  the caller's role does not hold it; report it, do not retry, do not look for
  another operation that does the same thing. A `403` the row or the target
  space decided keeps the route's own problem+json alone — the caller holds
  every listed permission, so that sentence would be false. Telemetry keeps
  `outcome: "invoked", status: 403` (already filterable; no taxonomy change).

### Predicates in core

`packages/core/src/permissions.ts`:

```ts
export function canReadRuns(has): boolean; // moved from apps/api/lib/run-visibility.ts; read-all implies read
export function canRunAgents(has): boolean; // has("agents:run") && canReadRuns(has)
export function canComposeInline(has): boolean; // unchanged
```

`mcp:invoke` gets no predicate of its own: it is a single `has()` with no rule
to share, and wrapping one membership test would only hide where the gate is.

The declarations built on them: `invoke_operation` on `mcp:invoke`;
`run_and_wait` on `mcp:invoke` ∧ `canRunAgents` (its `kind:"inline"` arguments
on `canComposeInline` as well); `list_files` when the caller is granted
`GET /api/files` (`listFiles` in the catalog). The chat computes the same flags
from the turn's permission set: `mcp:read` ∧ `mcp:invoke` is the floor (the MCP
transport admits nobody without `mcp:read`), then `canReadRuns` / `canRunAgents`
/ `canComposeInline`.

`apps/api/lib/run-visibility.ts` re-exports nothing: its callers import core.
`apps/web/src/modules/chat/chat-access.ts` builds every row on these; the
comment "mirrors server-side" goes away because there is no mirror.

### Chat prompt and server instructions

`turnCapabilities(has)` (`packages/module-chat/src/capabilities.ts`) derives the
turn's answer ONCE from its permission set — `{ invokes, runLevel, authors }`,
`runLevel` being `none | read | run | compose` — and `buildSystemPrompt` takes
that `TurnCapabilities` rather than a flag per question. Below `run`, every
`run_and_wait` paragraph is absent, the decision tree has no "run an agent"
branch, and the caller-context block lists no agent as runnable.
`buildServerInstructions` does the same for the run bullets (`runOps`, the
shortcut, the readiness guidance). The chat stream and the web chip read the
same derivation, so core keeps the predicates and no `mcp:*` vocabulary leaks
into them.

The caller-context block carries the caller's role in the current space and
the turn's permission set as DATA, in the same `resource:action` vocabulary as
an operation's `required_permissions`, so the model joins the two itself
instead of inferring what it may call.

Flipping the authoring toggle already re-mints the token per turn, so the
declarations follow without `listChanged`.

## Non-goals

- No pre-dispatch refusal, no second policy engine.
- No new per-turn toggles; no "ask before this call" mode.
- No `x-permissions` in the served OpenAPI document. The derived map makes it a
  one-line addition later, with its own baseline churn; not needed for this.
- No `notifications/tools/list_changed`: the token, and with it the declared
  set, is fixed for a turn.

## Docs to touch

- `docs/architecture/RBAC_PERMISSIONS_SPEC.md` §4.3: guards are
  introspectable, and the MCP surface is derived from them; §13: the rejected
  shapes (declared `x-permissions`, pre-dispatch refusal, capability endpoint).
- `apps/api/src/modules/mcp/catalog.ts` header: the index is per operation
  and derived; the "heuristic, not a security boundary" sentence stays true and
  stays.
