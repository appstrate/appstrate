# MCP V2 — Runtime Protocol 2.0

This document describes the MCP-native runtime (`runtimeProtocolVersion: "2.0"`) that replaced the previous proxy-based runtime in a single cutover. The cutover was a hard switch: legacy paths were retired in-tree without a soft-deprecation window because this OSS controls every runner and bundle.

## TL;DR

- **Wire format:** Streamable HTTP MCP (`POST /mcp`) is the agent-tool-call surface between the agent container and the sidecar. The Pi SDK additionally hits `/llm/*` over HTTP for chat completions — that route is a placeholder-substituting reverse proxy, not an MCP endpoint, and never exposes the LLM key to the agent.
- **LLM-facing surface:** three canonical tools — `provider_call`, `run_history`, `llm_complete` — across every execution mode (Docker container, in-process subprocess, CLI).
- **Capability prompt:** `## Connected Providers` documents `provider_call({ providerId, method, target, ... })` as the single entry point. Each connected provider contributes one `providerId` value to the tool's enum plus a doc reference.
- **No runtime flags** — direct MCP is the only mode.

## Compatibility

A pre-cutover 1.x runner against a 2.0 platform crashes at boot — the legacy `/proxy` and `/run-history` HTTP routes return 404, and the runner has no MCP client to fall back on. The `/llm/*` reverse proxy is preserved across versions because the Pi SDK consumes it directly over HTTP. Operators who pinned a 1.x runner image must either upgrade the runner or pin the platform to a pre-cutover commit. There is no soft-deprecation period.

## What 2.0 looks like on the wire

```
POST /mcp        # JSON-RPC 2.0, Streamable HTTP, stateless, per-request transport
```

`tools/list` advertises three tools and dispatches via `tools/call`:

- `provider_call({ providerId, method, target, headers?, body?, responseMode?, substituteBody? })` — credential-injecting proxy. `providerId` enum is the agent's declared providers. The sidecar's MCP handler delegates to the pure `executeProviderCall` helper in `runtime-pi/sidecar/credential-proxy.ts`.
- `run_history({ limit?, fields? })` — past-run metadata via the platform's per-run-token internal endpoint.
- `llm_complete(...)` — LLM-as-a-tool path for sub-agent workflows (the agent's own primary completions go over the Pi SDK's HTTP `${MODEL_BASE_URL}/v1/chat/completions` call, which the sidecar serves via the `/llm/*` placeholder-substituting reverse proxy).

Binary upstream responses surface as MCP `resource_link` blocks read back through `resources/read`.

## Tool descriptors

Every third-party MCP tool descriptor is sanitised before being advertised to the agent's LLM. Hidden Unicode (zero-width, RTL/bidi overrides, BOM, Hangul/Khmer fillers), C0 control chars (except `\n`/`\t`), and oversize fields are stripped. Limits:

| Field                 | Cap        |
| --------------------- | ---------- |
| Tool description      | 2048 bytes |
| Parameter description | 512 bytes  |
| Total schema          | 8192 bytes |

Descriptors that exceed the schema cap after sanitisation are dropped entirely; the host emits a `tool_rejected` log event.

## Tool naming

Third-party MCP servers are namespaced as `{namespace_snake}__{tool_snake}`. Examples:

- ✅ `fs__read_file`
- ✅ `notion__search_pages`
- ❌ `mcp-fs__read_file` (mixed separators, redundant prefix)

The 56-character ceiling and pattern are validated by `@appstrate/core/naming`'s bifurcated predicates: `isValidToolNameForNew` at publish time, `isValidToolNameForExisting` at runtime.

## `runtime-ready` event envelope

The `appstrate.progress` event runtime-pi emits during boot carries a `runtimeProtocolVersion` field on its `data` payload:

```json
{
  "type": "appstrate.progress",
  "message": "runtime ready in 1234ms",
  "data": {
    "bundleLoaded": true,
    "extensions": 4,
    "runtimeProtocolVersion": "2.0"
  }
}
```

## Tool-package manifest extension

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

The runner reads `runtime`. If it's `"mcp-server"`, the tool loads via `@appstrate/mcp-transport`'s `loadToolMcpServer()`. Anything else flows through the in-process loader. AFPS spec is unchanged — this lives in `definition` (§3.4 leaves that field to the runner).

## Bundle authors

The platform composes the `## Connected Providers` section automatically. Bundle prompts only need to:

1. Reference the canonical tool by name (`provider_call`).
2. Pick the relevant `providerId` from the enum the platform-prompt enumerates.

A typical bundle prompt body for a Gmail summariser now reads:

```md
Use `provider_call` with `providerId: "@appstrate/gmail"` to read the user's
inbox. Pass `target` URLs that match the authorized URL list shown above.
```

`dependencies.providers` is unchanged in shape — it still drives both bundle resolution and the LLM-facing `providerId` enum.

## CLI parity

`apps/cli` runs agents in-process (no sidecar). It consumes
`buildProviderCallExtensionFactory` from `@appstrate/runner-pi`, which takes the AFPS `ProviderResolver` (typically `RemoteAppstrateProviderResolver` against a deployed platform) and exposes the same `provider_call` Pi tool. The capability prompt is therefore identical for CLI and container runs.

## Rollback

There is no per-run flag. Reverting to the pre-cutover protocol requires reverting the cutover commits or pinning the platform to a pre-cutover commit; mismatched runners (1.x runner against 2.0 platform, or vice versa) fail at boot.

## Reference

- **Capability discovery:** `AppstrateMcpClient.getServerCapabilities()` / `getServerVersion()`.
- **Tool descriptor sanitisation:** `@appstrate/mcp-transport`'s `sanitiseToolDescriptor`.
- **Subprocess transport:** `@appstrate/mcp-transport`'s `SubprocessTransport` + `loadToolMcpServer`.
- **Credential isolation invariant:** `runtime-pi/sidecar/credential-proxy.ts`'s `executeProviderCall` is the single code path for all credential-injecting outbound traffic.
