# Sidecar — credential-isolating MCP server

A small Hono server that runs in its own Docker container alongside every Appstrate agent run. The agent container talks to the sidecar over the run's private bridge network. Agent tool calls flow exclusively over the **Model Context Protocol** (Streamable HTTP, stateless); the in-container Pi SDK additionally reaches the sidecar over plain HTTP for chat completions, where it streams the LLM provider's native protocol back unchanged. The sidecar holds the credentials, talks to upstream provider/LLM APIs, and returns responses to the agent as MCP `tools/call` results, `resource_link` blocks, or — for `/llm/*` — a transparent stream-through.

The agent container has no platform credentials, no access to `host.docker.internal`, and no `SIDECAR_URL` env var after bootstrap. All credential-bearing capabilities are exposed to the agent LLM as typed Pi tools — never as a bare URL.

## HTTP surface

The sidecar's external HTTP surface is intentionally small:

- `GET /health` — Readiness probe. Returns 200 when ready, 503 (`{ status: "degraded" }`) otherwise.
- `POST /configure` — One-time runtime configuration for pool-pre-warmed sidecars (`runToken`, `platformApiUrl`, `proxyUrl`, optional `llm`). Authenticated via `Bearer ${CONFIG_SECRET}` and locked after first use. Permanently locked when the sidecar was started fresh with `RUN_TOKEN` already in the environment.
- `ALL /llm/*` — LLM reverse proxy consumed by the in-container Pi SDK as `${MODEL_BASE_URL}/v1/chat/completions` (or equivalent). The sidecar substitutes the per-run placeholder embedded in SDK-generated headers for the real LLM API key, then streams the upstream response back zero-copy. SSRF-blocked against private/metadata addresses; bound by `LLM_PROXY_TIMEOUT_MS`.
- `ALL /mcp` — JSON-RPC entrypoint mounted by `mountMcp`. Per-request transport, no session affinity. Authenticated via `Authorization: Bearer ${runToken}`. The Host header is validated against `{sidecar, 127.0.0.1, localhost}` regardless of port (DNS-rebinding defence).

## MCP tools

The `/mcp` endpoint advertises three first-party tools, all backed by `executeProviderCall` and the platform's per-run-token internal endpoints:

| Tool            | Purpose                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_call` | Credential-injecting outbound proxy. Routed by `providerId`, validated against `authorizedUris`.                                                                                                                          |
| `run_history`   | Past-run metadata via the platform's per-run-token internal endpoint.                                                                                                                                                     |
| `llm_complete`  | LLM-as-a-tool for sub-agent workflows. The agent's primary completions go over the HTTP `/llm/*` route consumed by the Pi SDK; `llm_complete` is for tool-call paths where the agent itself wants to invoke a completion. |

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
2. The runner-pi `McpProviderResolver` (in container mode) — or `RemoteAppstrateProviderResolver` (in CLI mode) — reads the workspace bytes locally via `resolveBodyForFetch` (path-safe, lstat-checked).
3. JSON-RPC has no native byte type, so the resolver base64-encodes the bytes and ships them over MCP as `body: { fromBytes: <base64>, encoding: "base64" }`.
4. The sidecar's `provider_call` MCP handler decodes once and forwards the bytes byte-for-byte to upstream — never seeing the source path.

The MCP `provider_call.body` schema accepts either `string` (text/JSON) or `{ fromBytes, encoding: "base64" }` (binary). The `{ fromFile }`, `{ multipart }`, and inline-`Uint8Array` shapes are runtime-side conveniences resolved client-side before MCP — the sidecar only sees the canonical wire forms.

The download counterpart (`responseMode.toFile`) is the same in reverse: the resolver reads the response bytes (inline text block or `resource_link` → `resources/read`) and writes them to the workspace before handing a `{ kind: "file", path, size, sha256 }` summary back to the agent.

## What lives outside this README

- The resolver-side contract — file resolution, `responseMode` logic, `byteLength` thresholds — is documented next to the code in [`packages/afps-runtime/src/resolvers/provider-tool.ts`](../../packages/afps-runtime/src/resolvers/provider-tool.ts).
- Sidecar pool lifecycle, network isolation, parallel container startup, and credential reporting paths are documented in the platform-level [`CLAUDE.md`](../../CLAUDE.md) under "Sidecar Protocol".
- Provider auth modes (`oauth2` / `oauth1` / `api_key` / `basic` / `custom`) and the `credentialHeaderName` / `credentialHeaderPrefix` injection contract live in `@appstrate/connect`.
