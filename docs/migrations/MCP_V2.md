# MCP V2 — Runtime Protocol 2.0 (final state)

This worktree completes the migration from the legacy proxy-based runtime (`runtimeProtocolVersion: "1.0"`) to the MCP-native runtime (`"2.0"`). The 18-month V6 sunset window was skipped: this OSS controls every runner and bundle in-tree, so the legacy paths were retired in a single PR rather than carried for compatibility.

## TL;DR

- **Wire format:** Streamable HTTP MCP (`POST /mcp`) is the only application-protocol surface. The sidecar's bespoke `/proxy`, `/run-history`, and `/llm/*` HTTP routes were removed.
- **LLM-facing surface:** three canonical tools — `provider_call`, `run_history`, `llm_complete` — across every execution mode (Docker container, in-process subprocess, CLI). The legacy `appstrate_<slug>_call` per-provider tool naming is gone.
- **Capability prompt:** `## Connected Providers` now documents `provider_call({ providerId, method, target, ... })` as the single entry point. Each connected provider contributes one `providerId` value to the tool's enum + a doc reference.
- **No flags.** `RUNTIME_MCP_CLIENT` and `RUNTIME_MCP_DIRECT_TOOLS` were removed from `runtime-pi/env.ts` and from `packages/runner-pi/src/container-env.ts`.

## Compatibility matrix

| Runner                                              | Platform `main`                       | Platform `feat/mcp-runtime-adapter` (this branch) |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| **1.x** (legacy `/proxy`, `/llm/*`, `/run-history`) | ✅ Full support                       | ❌ Not supported — legacy routes removed          |
| **2.0** (MCP only)                                  | ❌ Not supported (no `/mcp` endpoint) | ✅ Full support                                   |

A 1.x runner against a 2.0 platform crashes at boot when it tries to `GET /run-history` or `POST /proxy` — the routes return 404. There is no soft-deprecation period.

## What 2.0 looks like on the wire

```
POST /mcp        # JSON-RPC 2.0, Streamable HTTP, stateless, per-request transport
```

`tools/list` advertises three tools and dispatches via `tools/call`:

- `provider_call({ providerId, method, target, headers?, body?, responseMode?, substituteBody? })` — credential-injecting proxy. `providerId` enum is the agent's declared providers. The sidecar's MCP handler delegates to `executeProviderCall` (the pure helper formerly behind `/proxy`).
- `run_history({ limit?, fields? })` — past-run metadata via the platform's per-run-token internal endpoint.
- `llm_complete(...)` — platform-configured LLM passthrough.

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

The 56-character ceiling and pattern are validated by `@appstrate/core/naming`'s bifurcated predicates (`isValidToolNameForNew` at publish time, `isValidToolNameForExisting` at runtime).

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

Bundles with prompts that mention `appstrate_<slug>_call` need to be rewritten. The platform composes the `## Connected Providers` section automatically; bundle prompts only need to:

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

Rolling back the 2.0 protocol is a `git revert` against this branch's commits. There is no per-run flag. Operators who need to keep 1.x runners working should pin to the last commit on `main` before the 2.0 cutover.

## Reference

- **Migration plan source of truth:** `claudedocs/MCP_MIGRATION_PLAN.md`.
- **Acceptance criteria:** issue #276.
- **Capability discovery:** `AppstrateMcpClient.getServerCapabilities()` / `getServerVersion()`.
- **Tool descriptor sanitisation:** `@appstrate/mcp-transport`'s `sanitiseToolDescriptor`.
- **Subprocess transport:** `@appstrate/mcp-transport`'s `SubprocessTransport` + `loadToolMcpServer`.
- **Credential isolation invariant:** `runtime-pi/sidecar/credential-proxy.ts`'s `executeProviderCall` is now the single code path for all credential-injecting outbound traffic; the historical HTTP `/proxy` route shared the same helper before being removed.
