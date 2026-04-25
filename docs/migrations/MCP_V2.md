# Migrating to MCP V2 (Runtime Protocol 2.0)

This guide explains how to upgrade an Appstrate platform — and the AFPS bundles running on it — from the legacy proxy-based runtime (`runtimeProtocolVersion: "1.0"`) to the MCP-native runtime (`"2.0"`).

## TL;DR

- **Bump path:** `1.0 → 2.0`. No intermediate versions.
- **Wire format:** Streamable HTTP MCP (`POST /mcp`) replaces the bespoke `/proxy`, `/run-history`, and `/llm/*` routes.
- **LLM-facing surface:** unchanged by default. The legacy `appstrate_<slug>_call` tool names keep working through the alias layer in `runtime-pi/extensions/mcp-bridge.ts`.
- **New bundles:** opt in to the MCP-native tool surface (`provider_call`, `run_history`, `llm_complete`) via `RUNTIME_MCP_DIRECT_TOOLS=1`. The capability prompt collapses from per-provider sections to three lines.
- **Deprecation window:** 18 months from 2026-04-25 (so `2027-10-25`). The platform serves both `1.0` and `2.0` simultaneously throughout. Hard removal of legacy routes happens at the end of the window per the V6 telemetry gates.

## Compatibility matrix

| Runner                                                 | Platform 1.x                                    | Platform 2.0                                                                               |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **1.x** (legacy `/proxy`, `/llm/*`, `/run-history`)    | ✅ Full support                                 | ✅ Full support — legacy routes still mounted with RFC 9745 + RFC 8594 deprecation headers |
| **2.0 — alias mode** (`RUNTIME_MCP_CLIENT=1`, default) | ❌ Not supported (platform doesn't ship `/mcp`) | ✅ Full support                                                                            |
| **2.0 — direct mode** (`RUNTIME_MCP_DIRECT_TOOLS=1`)   | ❌ Not supported                                | ✅ Full support                                                                            |

## What changes

### Wire format

A 1.x runner makes three different shapes of HTTP request:

```
GET  /run-history?limit=10
POST /llm/v1/messages
GET  /proxy with X-Provider, X-Target, X-Stream-Response: 1
```

A 2.0 runner makes one shape:

```
POST /mcp        # JSON-RPC 2.0, Streamable HTTP, stateless
```

…and dispatches via `tools/call` to `provider_call`, `run_history`, `llm_complete`. Binary upstream responses surface as MCP `resource_link` blocks and are read back via `resources/read`.

### Tool descriptors

In 2.0, every third-party MCP tool descriptor is sanitised before being advertised to the agent's LLM. Hidden Unicode (zero-width, RTL/bidi overrides, BOM, Hangul/Khmer fillers), C0 control chars (except `\n`/`\t`), and oversize fields are stripped. Limits:

| Field                 | Cap        |
| --------------------- | ---------- |
| Tool description      | 2048 bytes |
| Parameter description | 512 bytes  |
| Total schema          | 8192 bytes |

Descriptors that exceed the schema cap after sanitisation are dropped entirely; the host emits a `tool_rejected` log event so operators can audit.

### Tool naming

Third-party MCP servers are namespaced as `{namespace_snake}__{tool_snake}`. Examples:

- ✅ `fs__read_file`
- ✅ `notion__search_pages`
- ❌ `mcp-fs__read_file` (mixed separators, redundant prefix)

The 56-character ceiling and pattern are validated by `@appstrate/core/naming`'s bifurcated predicates (`isValidToolNameForNew` at publish time, `isValidToolNameForExisting` at runtime).

### `runtime-ready` event envelope

The `appstrate.progress` event runtime-pi emits during boot now carries a `runtimeProtocolVersion` field on its `data` payload:

```diff
 {
   "type": "appstrate.progress",
   "message": "runtime ready in 1234ms",
   "data": {
     "bundleLoaded": true,
     "extensions": 4,
+    "runtimeProtocolVersion": "2.0"
   }
 }
```

Existing 1.x consumers ignore unknown fields per the event-envelope spec — no breaking change.

### Tool-package manifest extension

A tool package can declare itself as a subprocess MCP server in its `definition` block:

```jsonc
{
  "name": "@scope/notion-mcp",
  "type": "tool",
  "definition": {
    "runtime": "mcp-server",
    "entrypoint": "./server.js",
    "transport": "stdio",
    "envAllowList": ["NOTION_TOKEN"],
    "trustLevel": "third-party",
  },
}
```

The runner reads `runtime`. If it's `"mcp-server"`, the tool loads via `@appstrate/mcp-transport`'s `loadToolMcpServer()`. Anything else flows through the legacy in-process loader. AFPS spec is unchanged — this lives in `definition` (§3.4 leaves that field to the runner).

## Step-by-step upgrade

### Self-hosters (platform side)

1. **Pull the 2.0 platform image.** The new image still serves `/proxy`, `/run-history`, `/llm/*` — the deprecation window keeps them live with RFC 9745 + RFC 8594 headers.
2. **Verify the deprecation telemetry.** Operators tracking the sunset can grep their access logs for `Deprecation:` and `Sunset:` headers; both surfaces emit identical V2 dates.
3. **No DB migration required.** All Phase 2-6 changes are runtime-pi + sidecar. The platform-side run-event-ingestion accepts both `1.x` and `2.0` envelope shapes.
4. **Plan the cutover.** Per V6, the hard removal at `2027-10-25` is gated by five telemetry signals — synthetic traffic in staging, partner notification, ≥99% of runners on 2.0, no inbound 1.x traffic on canary, and operator dashboard sign-off. Until those hold, the legacy routes stay live.

### Bundle authors

If your bundle's prompt references `appstrate_<provider>_call`, you don't need to change anything. The alias layer in `runtime-pi/extensions/mcp-bridge.ts` keeps it working through 2.0 and one minor cycle into 3.0.

If you want the new MCP-native vocabulary:

1. **Replace the per-provider prompt section with the 3-line capability prompt:**

   Before:

   ```md
   ## Available Providers

   - appstrate_gmail_call(method, target, headers, body, ...): description...
   - appstrate_clickup_call(...): description...
   ```

   After:

   ```md
   ## Capabilities

   You have access to MCP tools through the standard MCP protocol.
   Discover them via `tools/list`. Each tool's input schema is self-documenting.
   ```

   The exact string is exported as `DIRECT_TOOL_PROMPT` from `runtime-pi/extensions/mcp-direct.ts`.

2. **Ensure your bundle declares its providers in `dependencies.providers`** — the direct tool path uses this to populate the `provider_call.providerId` enum.

3. **Set `RUNTIME_MCP_DIRECT_TOOLS=1`** when you ship the bundle. The platform respects per-run env injection — no global flag flip needed.

4. **Validate end-to-end** in a staging run before promoting. The MCP wire path is fully observable: the sidecar logs every `tools/call` dispatch as a structured event, and the host emits `provider.called`/`provider.completed`/`provider.failed` lifecycle events on the run sink.

## Rollback

Rolling back a MAJOR runtime protocol bump cleanly is not possible mid-flight. The mitigation is the 18-month V6 sunset window itself: legacy routes stay live for the full window, so a 1.x runner can continue talking to a 2.0 platform indefinitely until the operator chooses to flip the kill switch.

If a critical issue is found in the 2.0 path:

1. Set `RUNTIME_MCP_CLIENT=0` on the agent runner. This forces the legacy path through the proxy routes — no platform redeploy needed.
2. File the regression with reproduction steps.
3. The platform team ships a hotfix that re-introduces the legacy path inside the new code if necessary.

## Reference

- **Migration plan source of truth:** `claudedocs/MCP_MIGRATION_PLAN.md`.
- **Acceptance criteria:** issue #276.
- **Capability discovery surface:** `AppstrateMcpClient.getServerCapabilities()` / `getServerVersion()` (Phase 6, V7 research validation).
- **Deprecation header registry:** `@appstrate/mcp-transport`'s `DEPRECATIONS`.
- **Tool descriptor sanitisation:** `@appstrate/mcp-transport`'s `sanitiseToolDescriptor`.
- **Subprocess transport:** `@appstrate/mcp-transport`'s `SubprocessTransport` + `loadToolMcpServer`.
