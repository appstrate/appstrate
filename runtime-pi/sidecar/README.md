# Sidecar — credential-isolating MCP server

A small Hono server that runs in its own Docker container alongside every Appstrate agent run. The agent container talks to the sidecar over the run's private bridge network exclusively via the **Model Context Protocol** (Streamable HTTP, stateless). The sidecar holds the credentials, talks to upstream provider APIs, and returns responses to the agent as MCP `tools/call` results or `resource_link` blocks.

The agent container has no platform credentials, no access to `host.docker.internal`, and no `SIDECAR_URL` env var after bootstrap. All sidecar-backed capabilities are exposed to the agent LLM as typed Pi tools — never as a bare URL.

## HTTP surface

The sidecar's external HTTP surface is intentionally small:

- `GET /health` — Readiness probe. Returns 200 when ready, 503 (`{ status: "degraded" }`) otherwise.
- `POST /configure` — One-time runtime configuration for pool-pre-warmed sidecars (`runToken`, `platformApiUrl`, `proxyUrl`, optional `llm`). Authenticated via `Bearer ${CONFIG_SECRET}` and locked after first use. Permanently locked when the sidecar was started fresh with `RUN_TOKEN` already in the environment.
- `ALL /mcp` — JSON-RPC entrypoint mounted by `mountMcp`. Per-request transport, no session affinity. Authenticated via `Authorization: Bearer ${runToken}`.

## MCP tools

The `/mcp` endpoint advertises three first-party tools, all backed by `executeProviderCall` and the platform's per-run-token internal endpoints:

| Tool            | Purpose                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `provider_call` | Credential-injecting outbound proxy. Routed by `providerId`, validated against `authorizedUris`. |
| `run_history`   | Past-run metadata via the platform's per-run-token internal endpoint.                            |
| `llm_complete`  | Platform-configured LLM passthrough — sidecar holds the LLM provider key.                        |

Third-party MCP servers can be mounted alongside the first-party tools via `SubprocessTransport` and the multiplexing `McpHost` in `mcp-host.ts`. Each upstream is namespaced as `{namespace}__{tool}`. Descriptors are passed through `sanitiseToolDescriptor` (hidden-Unicode strip, length caps, Full-Schema-Poisoning recursion) before being advertised to the agent.

## Binary safety

`provider_call` upstream responses are byte-exact: the sidecar reads the upstream body via `arrayBuffer()` and either returns the bytes inline (text under `INLINE_RESPONSE_THRESHOLD`) or stores them in the run-scoped `BlobStore` and returns a `resource_link` block. No `.text()` decode, no UTF-8 round-trip, no implicit Content-Type rewriting.

The only path that decodes the request body to UTF-8 is the optional `substituteBody: true` argument, which performs `{{variable}}` placeholder substitution on a buffered body.

## Size limits

| Constant                     | Value  | Purpose                                                                |
| ---------------------------- | ------ | ---------------------------------------------------------------------- |
| `MAX_RESPONSE_SIZE`          | 256 KB | Default cap on upstream response bytes returned inline to the agent.   |
| `ABSOLUTE_MAX_RESPONSE_SIZE` | 1 MB   | Ceiling on `responseMode.maxInlineBytes` regardless of caller request. |
| `MAX_SUBSTITUTE_BODY_SIZE`   | 5 MB   | Maximum buffered request body size accepted with `substituteBody`.     |
| `STREAMING_THRESHOLD`        | 1 MB   | Above this `Content-Length` `provider_call` switches to streaming.     |
| `MAX_STREAMED_BODY_SIZE`     | 100 MB | Ceiling on streamed request and response bodies.                       |
| `INLINE_RESPONSE_THRESHOLD`  | 32 KB  | Above this responses spill to the `BlobStore` as a `resource_link`.    |
| `OUTBOUND_TIMEOUT_MS`        | 30 s   | Upstream `provider_call` request timeout.                              |
| `LLM_PROXY_TIMEOUT_MS`       | 5 min  | `llm_complete` request timeout (long enough for streamed completions). |

When the upstream response exceeds the inline threshold, the bytes are stored in the run-scoped `BlobStore` (256 MB cap, ULID URIs, traversal-safe) and the tool returns a `resource_link` block. The agent reads the bytes on demand via `client.readResource({ uri })`.

## The `body.fromFile` contract

The AFPS provider tool exposes `body.fromFile` so agents can upload workspace files without base64-encoding them into a JSON tool argument. **The sidecar has no workspace mount and no knowledge of `fromFile`** — that contract is purely runtime-side:

1. The agent calls `provider_call` with `{ body: { fromFile: "report.pdf" } }`.
2. The AFPS resolver in `packages/afps-runtime/src/resolvers/provider-tool.ts` reads the workspace bytes locally.
3. The resolver invokes the MCP `provider_call` tool with the raw bytes as the body, plus the appropriate `Content-Type`.
4. The sidecar sees only bytes — by design.

The download counterpart (`responseMode.toFile`) is the same in reverse: the resolver opts into the streaming path, reads the response bytes, and writes them to the workspace before handing a `{ savedTo, byteLength }` summary back to the agent.

## What lives outside this README

- The resolver-side contract — file resolution, `responseMode` logic, `byteLength` thresholds — is documented next to the code in [`packages/afps-runtime/src/resolvers/provider-tool.ts`](../../packages/afps-runtime/src/resolvers/provider-tool.ts).
- Sidecar pool lifecycle, network isolation, parallel container startup, and credential reporting paths are documented in the platform-level [`CLAUDE.md`](../../CLAUDE.md) under "Sidecar Protocol".
- Provider auth modes (`oauth2` / `oauth1` / `api_key` / `basic` / `custom`) and the `credentialHeaderName` / `credentialHeaderPrefix` injection contract live in `@appstrate/connect`.
