# One MCP connection per organization, every space the caller reaches

Status: **implemented** (#1825). The code is `modules/mcp/spaces.ts` and its
callers in `modules/mcp/router.ts` and `modules/mcp/tools.ts`.

## Problem

`/api/mcp/o/:org` serves one organization, but a connection used to work in
exactly one space: a strategy-pinned space (API key), then the `X-Space-Id`
header, then the org's default space. The model cannot move: `x-space-id` and
`x-org-id` are in `PROTECTED_HEADERS` (`modules/mcp/tools.ts`), so
`invoke_operation` refuses to set them.

A person who works in several spaces of one organization therefore registered
one MCP connection per space, each with its own OAuth consent and its own copy
of the tools in every session. A real setup: four connections to the same
organization. Each is the same server, the same token audience and the same
person; only the header differs.

That constraint predates the per-space RBAC of #1493 and #1498. The route
guards decide every call in the space the call lands in, and the MCP surface is
derived from those guards. Nothing in the security model still needs the space
to be fixed for the whole connection.

## Goal

An unpinned connection reaches every space the caller reaches, and each call
names the space it acts in. A pinned connection behaves as before.

Non-goals: crossing organizations (one endpoint, one token audience, one org
stays the rule); changing any route guard; per-space OAuth consent.

## Design

### 1. Two modes, decided once per request

| Mode     | When                                                                                   | Behaviour                      |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| pinned   | a strategy pins a space (API key, end-user token), or the request carries `X-Space-Id` | one space                      |
| org-wide | anything else                                                                          | every space the caller reaches |

An end-user token always pins its space (RBAC spec §3.6). A pin stays the way
to give a delegated client least privilege.

### 2. Discovering the spaces

In org-wide mode the router calls `listSpacesForPrincipal` (`services/spaces.ts`,
the source of `GET /api/spaces`, persona overlay included) once per request.
For each space with a role, `effectiveInSpace(c, role)` gives the permission set
there and `deriveMcpSurface` the acts it allows, in memory. Spaces visible
without a role, and spaces whose role holds no `mcp:read`, are left out: the MCP
acts, it does not browse. A principal without an org role reaches none.

A caller who reaches no space is refused with a 403. There is no default space
to fall back to (§8).

`get_me` adds the list to the `/api/me/context` payload: `spaces: [{ id, name,
role }]`. The REST route is unchanged.

### 3. `space_id` on every tool that acts in a space

`SPACE_ACTS` (`modules/mcp/tools.ts`) states, for EVERY tool, whether it acts
in a space and which act of its surface it needs there. It is exhaustive over
`McpToolName`, so a new tool cannot silently act in whichever space the request
entered. `get_runtime_capabilities` alone acts in none.

- **One space per HTTP request.** The transport is stateless and a
  `tools/call` request carries one call, so the router reads that call's
  `space_id` from the JSON-RPC body before it builds the tools, and enters the
  space through the header's own door, `enterSpaceById`. Everything downstream
  is single-space: the request context holds that space's role, so the
  direct-service tools (`read_skill`, the file resource provider, the package
  file tools) need no change. A request naming no space (`initialize`,
  `tools/list`) enters a reachable one only to pass the `mcp:read` guard.
- **Validation:** an id outside the reachable list is a `-32602` naming the
  reachable spaces. The argument is never trusted as such: the router admits
  the space with the caller's membership, as for the header.
- **Dispatched tools** carry `X-Space-Id` for the space entered, pinned or
  org-wide alike, so the re-entered `requireSpaceContext` decides with the role
  of that space and nothing else. `x-space-id` stays protected in the `headers`
  argument: the only way to change space is the typed argument.
- **The tool's own grant is re-checked in the space entered.** The declared
  tools are the union of the spaces (§6), so `invoke_operation` called in a
  space whose role lacks `mcp:invoke` is refused there, naming the spaces that
  grant it. Same for `run_and_wait` (and `kind:"inline"` as its own act,
  `composes`), `list_files` and `import_package_file`.
- **In pinned mode** `space_id` is not declared at all, so passing one is the
  usual `-32602` for an unknown argument.

### 4. Every call names its space

`space_id` is **required** on every tool that acts in a space, reads and writes
alike, whether the caller reaches one space or several: one schema, no default
space, no single-space exception. A missing one is a `-32602` naming the spaces
and the caller's role in each, so a model recovers in one turn.
`invoke_operation`, `run_and_wait` and `describe_operation` results name the
space they ran in (`space: { id, name }`; `run_and_wait`'s `outputSchema`
declares it).

### 5. Refusals forbid the fallback

The real risk of org-wide mode is not an action the caller may not take (the
guard refuses it); it is a model that, refused in space B, does the same thing
in space A where it is allowed.

Every refusal that comes from a permission (`invoke_operation`, `describe`'s
`granted: false`, the per-space re-check of §3) carries the space it was
decided in, the spaces where the same act is granted (`granted_in`), and a
fixed instruction: do not retry in another space; report the refusal to the
user, who decides where the action belongs. The server instructions state the
same rule once.

### 6. The tool surface is the union, the index says where

- **Tools:** a tool is declared when its act holds in at least one space. This
  is safe because of the rule #1493 set: the surface informs, the guard
  decides. A tool granted in only some spaces ends its description with
  `Available in: team, gestion.`.
- **Operation index:** one grouping, by tag. An operation granted in only some
  spaces names them after its id (`createAgent [gestion]`); one granted
  everywhere carries nothing, so when every space grants the same operations
  the index is the pinned one.
- `search_operations` and `describe_operation` answer for the space named and
  carry `granted_in` when it is not all the caller's spaces.
- A delegated credential's ceiling applies to every space alike.

### 7. Trace

The `mcp.operation.invoked` audit row and the `mcp.tool_call` log line carry
`spaceId`.

### 8. No default-space fallback

Before this mode, an in-process MCP re-entry without `X-Space-Id` resolved to
the org's default space, through a branch of `requireSpaceContext` and of the
module space applier gated on the internal-dispatch marker. The router now
forwards the space it entered on every re-entry, and the chat loopback sends
its own, so that branch had no caller left and is gone: a request naming no
space is a 400 whatever its origin.

## Cost

Per request in org-wide mode: one `listSpacesForPrincipal` statement, and per
space one in-memory `effectiveInSpace` and `deriveMcpSurface`. Per call: one
admission read, the same one the header costs. No new table, no cache.

## Compatibility

- Pinned clients (`X-Space-Id`, API keys, end-user tokens): no change.
- Unpinned clients that relied on the default space pass `space_id` on every
  call. The refusal lists the spaces, so a model recovers in one turn. No flag
  and no compatibility branch (`docs/NO_TRANSITIONAL_CODE.md`).
- The in-process chat pins its space and stays pinned.

## Open questions

- Should `get_me` list spaces the caller can see but not enter, so the model can
  tell the user to ask for access?
- A size limit for the bracketed index: past some number of spaces, the
  brackets could give way to `granted_in` on `search_operations` only.
- The CLI plugin pins `X-Space-Id`; dropping the pin would let skills synced
  from several spaces act in their own space.
