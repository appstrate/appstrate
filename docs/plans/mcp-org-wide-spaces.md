# One MCP connection per organization, every space the caller reaches

Status: **RFC, implemented** in `feat/mcp-org-wide-spaces` for a local trial,
before an issue and a PR. The code is `modules/mcp/spaces.ts` and its callers;
where it departs from the first draft, this document says so.

## Problem

`/api/mcp/o/:org` serves one organization, but a connection works in exactly one
space. `enterMcpSpace` (`modules/mcp/router.ts`) resolves it once per request:
a strategy-pinned space (API key) first, then the `X-Space-Id` header, then the
org's default space. The model cannot move: `x-space-id` and `x-org-id` are in
`PROTECTED_HEADERS` (`modules/mcp/tools.ts`), so `invoke_operation` refuses to
set them.

A person who works in several spaces of one organization therefore registers
one MCP connection per space, each with its own OAuth consent and its own copy
of the tools in every session. A real setup today: four connections to the same
organization (`team`, `gestion`, `Mon espace`) plus one per other organization.
Each connection is the same server, the same token audience and the same
person. Only the header differs.

That constraint predates the per-space RBAC of #1493 and #1498. The guards on
the routes now decide every call in the space the call lands in, and the MCP
surface is derived from those guards. Nothing in the security model still needs
the space to be fixed for the whole connection.

## Goal

An unpinned connection reaches every space the caller reaches, and each call
names the space it acts in. A pinned connection behaves exactly as today.

Non-goals: crossing organizations (one endpoint, one token audience, one org
stays the rule); changing any route guard; per-space OAuth consent.

## Design

### 1. Two modes, decided once per request

| Mode     | When                                                                                   | Behaviour                      |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| pinned   | a strategy pins a space (API key, end-user token), or the request carries `X-Space-Id` | unchanged: one space           |
| org-wide | none of the above, and the caller has an org role                                      | every space the caller reaches |

An end-user principal is always pinned: it belongs to one space (RBAC spec §3.6).
A pin stays the way to give a delegated client least privilege.

### 2. Discovering the spaces

In org-wide mode the router calls `listSpacesForPrincipal(orgId, orgRole,
userId, personalOwnerId)` (`services/spaces.ts`) once per request: one
statement, already the source of `GET /api/spaces`. For each space with a role,
`effectiveInSpace(c, role)` gives the permission set in that space, in memory.
Spaces the caller can see but not enter (`closed` without a role, orphaned
personal spaces) are left out, and so are spaces where the role holds no
`mcp:read`: the MCP acts, it does not browse.

The `get_me` tool adds them to the `/api/me/context` payload: `spaces: [{ id,
name, is_default, role }]`. The REST route is unchanged; the list is the MCP
connection's, so the tool that serves the connection carries it.

### 3. `space_id` on every tool that acts in a space

A `space_id` argument (pattern `spc_…`) is added to `search_operations`,
`describe_operation`, `invoke_operation`, `run_and_wait`, `list_files`,
`read_file`, `read_skill` and the package file tools.

- **One space per HTTP request.** The transport is stateless and a
  `tools/call` request carries one call, so the router reads that call's
  `space_id` from the JSON-RPC body before it builds the tools, and enters the
  space through the header's own door, `enterSpaceById`. Everything downstream
  is then single-space as today: the request context holds that space's role,
  so the direct-service tools (`read_skill`, the file resource provider, the
  package file tools) need no change. A batch naming two spaces is refused for
  the call that does not match the space entered.
- **Validation:** an id outside the reachable list is a `-32602` naming the
  reachable spaces. The argument is never trusted as such: the router admits
  the space with the caller's membership, as for the header.
- **Dispatched tools** (`invoke_operation`, `run_and_wait`, `get_me`,
  `list_files`) carry `X-Space-Id` for the space entered. The re-entered
  `requireSpaceContext` admits it again, so the route guard decides with the
  role of that space and nothing else. `x-space-id` stays protected in the
  `headers` argument: the only way to change space is the typed argument.
- **The tool's own grant is re-checked in the space entered.** The declared
  tools are the union of the spaces (§6), so `invoke_operation` called in a
  space whose role lacks `mcp:invoke` is refused there, naming the spaces that
  grant it. Same for `run_and_wait`, `list_files`, `import_package_file`.
- **In pinned mode** `space_id` is not declared at all, so passing one is the
  usual `-32602` for an unknown argument. (First draft: a `space_pinned`
  refusal. The unknown-argument refusal already says the same thing.)

### 4. Every call names its space

In org-wide mode `space_id` is **required** on every tool that acts in a space,
reads and writes alike, whether the caller reaches one space or several: one
schema, no default space, no single-space exception. A missing one is a
`-32602` naming the spaces and the caller's role in each, so a model recovers
in one turn. `invoke_operation`, `run_and_wait` and `describe_operation`
results name the space they ran in (`space: { id, name }`).

(First draft: reads defaulted to the default space and only writes required
`space_id`, and only past one space. Decided against after the trial: one rule
everywhere is simpler to state and to follow, and a caller who reaches one space
gets the same tools and the same schema, just one space in the list.)

### 5. Refusals forbid the fallback

The real risk of org-wide mode is not an action the caller is not allowed to
take (the guard refuses it), it is a model that, refused in space B, does the
same thing in space A where it is allowed: a copy of the skill in the wrong
space, a run billed to the wrong space, a result that looks like success.

Every refusal that comes from a permission (`invoke_operation`, `describe`'s
`granted: false`, the direct tools) carries:

- the space it was decided in, by id and name;
- the permission that was missing (already the case);
- the spaces where the same operation is granted;
- a fixed instruction: _do not retry this operation in another space; report the
  refusal to the user, who decides where the action belongs._

The server instructions state the same rule once.

### 6. The tool surface is the union, the index says where

The MCP transport is stateless (`sessionIdGenerator: undefined`), so the server
and its surface are built per HTTP request. `deriveMcpSurface` and
`buildServerInstructions` take a map `spaceId → permissions` instead of one set:

- **Tools:** a tool is declared when its condition holds in at least one space
  (`invokes`, `runs`, `composes`, `listsFiles`, `importsPackages`). This is safe
  because of the rule #1493 set: the surface informs, the guard decides. A
  tool granted in only some spaces ends its description with `Available in:
team, gestion.`; one granted everywhere carries no such line. Each call
  re-checks the tool's own grant in the space it names (§3).
- **Operation index:** each operation is evaluated with `operationGranted(op,
permissions, ceiling)` (`modules/mcp/catalog.ts`, a pure function) once per
  space. The index keeps ONE grouping, by tag, as today: an operation granted
  in only some spaces names them after its id (`createAgent [gestion]`), one
  granted everywhere carries nothing. When every space grants the same
  operations, the index is exactly today's. (First draft: a second grouping by
  set of spaces, "Only in: gestion" sections after the tags. Dropped: it mixed
  two axes, what an operation does and where it is allowed, and moved
  `createAgent` out of its own tag. The brackets cost about 170 tokens for 58
  annotated operations, against three spaces with three roles.)
- `search_operations` and `describe_operation` answer for the space named, as
  today, and carry `granted_in` (the spaces that grant the operation) on every
  row, granted or denied, and on every describe, only when that is not all the
  caller's spaces: the same rule as the brackets of the index. A refusal always
  carries it, since the space refused is one that does not grant.
- Unchanged limits: an operation the row decides stays "possible, decided on
  the record"; target-space requirements never count (`isGranted`); a delegated
  credential's ceiling applies to every space alike.

### 7. Trace

The `mcp.operation.invoked` audit row and the `mcp.tool_call` log line gain
`space_id`. Every write result names its space, so a misplaced action is
visible at once.

## Cost

Per request in org-wide mode: one `listSpacesForPrincipal` statement, one
in-memory `effectiveInSpace` per space, and `operationGranted` per operation and
space (hundreds × a handful, pure set lookups). Per call with `space_id`: one
admission read, the same one the header costs today. No new table, no cache in
the first version.

## Compatibility

- Pinned clients (`X-Space-Id`, API keys, end-user tokens): no change.
- Unpinned clients that relied on the default space now pass `space_id` on
  every call. The refusal says
  which spaces exist, so a model recovers in one turn. There is no flag and no
  compatibility branch (`docs/NO_TRANSITIONAL_CODE.md`): org-wide is what an
  unpinned connection means.
- The in-process chat pins its space and stays pinned.

## Trial before the issue

1. Implement in the `feat/mcp-org-wide-spaces` worktree.
2. Tests: unit (surface union, index grouping, refusal body), integration (two
   spaces, admin in A and viewer in B: any call without `space_id` refused (one space or several), write
   to B refused with the no-fallback instruction,
   write to A accepted, header-pinned connection unchanged, `space_id` undeclared there).
3. Agent trial: Claude Code connected to the worktree instance with one
   unpinned connection, on scripted tasks (edit a skill in a named space, read
   across spaces, a task the caller may not do in the space it names). Measure
   wrong-space writes (target: zero), refusals recovered in one turn, and tool
   tokens against the four-connection setup.
4. If the trial holds: issue on GitHub with this document, then the PR.

## Open questions

- Should `get_me` list spaces the caller can see but not enter, so the model can
  tell the user to ask for access?
- A size limit for the bracketed index: past some number of spaces, the
  brackets could give way to `granted_in` on `search_operations` only.
