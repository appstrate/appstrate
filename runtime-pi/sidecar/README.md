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

The `/mcp` endpoint advertises three first-party tools, all backed by the platform's per-run-token internal endpoints:

| Tool            | Purpose                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_call` | Credential-injecting outbound proxy. Routed by `providerId`, validated against `authorizedUris`.                                                                                                   |
| `run_history`   | Past-run metadata via the platform's per-run-token internal endpoint.                                                                                                                              |
| `recall_memory` | Read the unified `package_persistence` archive — enumerates prior `note()` appends and (optionally) named pinned slots set via `pin()`. Replaces the legacy "Memory" prompt section (ADR-012/013). |

The agent's primary completions are served by the HTTP `/llm/*` route the Pi SDK calls natively; the sidecar does not expose a completions tool. Sub-agent workflows are handled platform-side by spawning a separate run.

Third-party MCP servers can be mounted alongside the first-party tools via `SubprocessTransport` and the multiplexing `McpHost` in `mcp-host.ts`. Each upstream is namespaced as `{namespace}__{tool}`. Descriptors are passed through `sanitiseToolDescriptor` (hidden-Unicode strip, length caps, Full-Schema-Poisoning recursion) before being advertised to the agent.

## Binary safety

`provider_call` upstream responses are byte-exact: the sidecar reads the upstream body via `arrayBuffer()` and either returns the bytes inline (text under the per-call token cap and within the run-level cumulative budget — see "Token-aware context budgeting" below) or stores them in the run-scoped `BlobStore` and returns a `resource_link` block. No `.text()` decode, no UTF-8 round-trip, no implicit Content-Type rewriting.

The only path that decodes the request body to UTF-8 is the optional `substituteBody: true` argument, which performs `{{variable}}` placeholder substitution on a buffered body.

## Size limits

| Constant                          | Value  | Purpose                                                                                                                                                                                                                                                  |
| --------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_RESPONSE_SIZE`               | 256 KB | Default cap on upstream response bytes returned inline to the agent.                                                                                                                                                                                     |
| `ABSOLUTE_MAX_RESPONSE_SIZE`      | 32 MB  | Ceiling on upstream bytes the sidecar buffers before refusing — only applied when a `BlobStore` is configured (otherwise `MAX_RESPONSE_SIZE` is the cap). Sized to cover real-world binaries (PDFs, images, archives) routed through the spillover path. |
| `MAX_SUBSTITUTE_BODY_SIZE`        | 5 MB   | Maximum buffered request body size accepted with `substituteBody`.                                                                                                                                                                                       |
| `STREAMING_THRESHOLD`             | 1 MB   | Above this `Content-Length` `provider_call` switches to streaming.                                                                                                                                                                                       |
| `MAX_STREAMED_BODY_SIZE`          | 100 MB | Ceiling on streamed request and response bodies.                                                                                                                                                                                                         |
| `INLINE_RESPONSE_THRESHOLD_BYTES` | 32 KB  | Legacy byte threshold; only consulted when no `TokenBudget` is configured. Production always wires a budget — see "Token-aware context budgeting" below.                                                                                                 |
| `OUTBOUND_TIMEOUT_MS`             | 30 s   | Upstream `provider_call` request timeout.                                                                                                                                                                                                                |
| `LLM_PROXY_TIMEOUT_MS`            | 5 min  | `/llm/*` HTTP passthrough timeout (long enough for streamed completions).                                                                                                                                                                                |

When the upstream response exceeds the inline threshold, the bytes are stored in the run-scoped `BlobStore` (256 MB cap, ULID URIs, traversal-safe) and the tool returns a `resource_link` block. The agent reads the bytes on demand via `client.readResource({ uri })`.

## Token-aware context budgeting

Byte caps protect the sidecar from OOM but do not reflect the true cost of a tool output in the agent's **context window**: 256 KB of dense JSON or base64 ≈ 60-90 K tokens, and 50 successive 30 KB calls (each well under the byte threshold) accumulate ~450 K tokens of context with no guard rail under a byte-only policy.

The sidecar layers two token-aware checks on top of the byte caps (see `token-budget.ts`):

| Knob                                    | Default        | Purpose                                                                                                                                                                                                                 |
| --------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIDECAR_INLINE_TOOL_OUTPUT_TOKENS`     | 8 000 tokens   | Per-call inline cap. Tool outputs above this spill to the `BlobStore` regardless of size — keeps the agent's context cost per call bounded.                                                                             |
| `SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS` | 200 000 tokens | Cumulative ceiling per run. As the agent's tool outputs accumulate, the inline path tightens; once the ceiling is breached, every text response spills. Operators on 1 M-context Sonnet 4.6 deployments can raise this. |

Token estimation uses the Anthropic-recommended **3.5 chars/token** heuristic — deterministic, allocation-free, suitable for the hot path of every `provider_call`. The official `@anthropic-ai/tokenizer` is no longer accurate for Claude 3+ models, and a real tokenizer (tiktoken / `count_tokens` API) would add 5-50 ms per call to the credential-injection round-trip.

Each text-path tool result carries an `appstrate://token-budget` `_meta` payload so the agent runtime can surface accounting and react to structured truncation events:

```jsonc
{
  "content": [{ "type": "text", "text": "<upstream body>" }],
  "_meta": {
    "appstrate://token-budget": {
      "estimatedTokens": 1234,
      "consumedTokens": 5000,
      "runBudgetTokens": 200000,
      "inlineCapTokens": 8000,
      "decision": "inline",
      "reason": "under_inline_cap",
    },
  },
}
```

`reason` is one of `under_inline_cap`, `exceeds_inline_cap`, `exceeds_run_budget`, or `no_blob_store_fallback_inline` (the last set when a forced spill failed because the blob store was already full — the agent paid the context cost as a last resort and the meta records the override).

## The `body.fromFile` contract

The AFPS provider tool exposes `body.fromFile` so agents can upload workspace files without base64-encoding them into a JSON tool argument. **The sidecar has no workspace mount and no knowledge of `fromFile`** — that contract is purely runtime-side:

1. The agent calls `provider_call` with `{ body: { fromFile: "report.pdf" } }`.
2. The runner-pi `McpProviderResolver` (in container mode) — or `RemoteAppstrateProviderResolver` (in CLI mode) — reads the workspace bytes locally via `resolveBodyForFetch` (path-safe, lstat-checked).
3. JSON-RPC has no native byte type, so the resolver base64-encodes the bytes and ships them over MCP as `body: { fromBytes: <base64>, encoding: "base64" }`.
4. The sidecar's `provider_call` MCP handler decodes once and forwards the bytes byte-for-byte to upstream — never seeing the source path.

The MCP `provider_call.body` schema accepts either `string` (text/JSON) or `{ fromBytes, encoding: "base64" }` (binary). The `{ fromFile }`, `{ multipart }`, and inline-`Uint8Array` shapes are runtime-side conveniences resolved client-side before MCP — the sidecar only sees the canonical wire forms.

The download counterpart (`responseMode.toFile`) is the same in reverse: the resolver reads the response bytes (inline text block or `resource_link` → `resources/read`) and writes them to the workspace before handing a `{ kind: "file", path, size, sha256 }` summary back to the agent.

## Upstream response-header propagation

`provider_call` ships upstream HTTP `status` + an allowlist of response headers back to the agent-side resolver via the MCP `_meta` field, namespaced as `appstrate/upstream`:

```jsonc
{
  "content": [{ "type": "text", "text": "<upstream body>" }],
  "_meta": {
    "appstrate/upstream": {
      "status": 308,
      "headers": { "location": "https://...", "content-range": "bytes=0-4194303" },
    },
  },
}
```

The allowlist is defined in [`runtime-pi/sidecar/upstream-meta.ts`](./upstream-meta.ts) and includes every header the four chunked-upload protocols depend on (`Location`, `ETag`, `Content-Range`, `Upload-Offset`, `Upload-Length`, `Tus-Resumable`, …) plus standard caching headers (`Cache-Control`, `Last-Modified`, `Vary`, `Retry-After`). Credential-bearing headers (`Set-Cookie`, `Authorization`, `WWW-Authenticate`) are deliberately excluded.

Old MCP clients ignore unknown `_meta` keys per spec — the propagation is wire-compatible.

The runtime-side parser at [`runtime-pi/mcp/upstream-meta.ts`](../mcp/upstream-meta.ts) re-applies the allowlist defensively, so a compromised sidecar can't slip an extra header through.

## Chunked uploads (`provider_upload`)

Files larger than `MAX_REQUEST_BODY_SIZE` (default 10 MB) cannot fit in a single `provider_call` envelope after base64 inflation. The runtime exposes a separate `provider_upload` Pi tool that orchestrates chunked uploads using the existing `provider_call` per chunk:

| Protocol           | Providers                                             | Notes                                                              |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `google-resumable` | Drive, Cloud Storage (XML/JSON), YouTube, Photos      | Chunks must be 256-KiB aligned (last excepted)                     |
| `s3-multipart`     | S3, R2, MinIO, Backblaze B2, Wasabi                   | Parts must be ≥5 MiB except the last; ETag aggregated via XML body |
| `tus`              | Cloudflare Stream, Vimeo, tusd, IETF Resumable Drafts | PATCH with `Upload-Offset`; HEAD for resume (out of scope)         |
| `ms-resumable`     | OneDrive, SharePoint, Microsoft Graph                 | Chunks must be 320-KiB aligned, ≤60 MiB                            |

Critically, **the sidecar is not modified**: each chunk transits through the existing `provider_call` MCP tool. Credential injection, `authorizedUris` enforcement, and SSRF protection apply per chunk identically. The chunking state machine lives in [`runtime-pi/mcp/upload-adapters/`](../mcp/upload-adapters/) — one ~150 LoC file per protocol — and never sees credentials.

A provider opts into `provider_upload` by declaring `definition.uploadProtocols: string[]` in its manifest. The tool is registered by the runtime only when ≥1 declared provider supports a known protocol; absent declarations, the tool isn't advertised.

The resolver streams the file off disk via `Bun.file().stream()`, slices it into `partSizeBytes`-sized chunks, computes a streaming SHA-256 over the bytes committed to the wire, and surfaces it in the result so post-upload byte-equivalence is verifiable. End-to-end memory ceiling is one chunk in the runtime + one chunk in the sidecar — bounded by `MAX_REQUEST_BODY_SIZE` regardless of file size.

Cancellation honours `ctx.signal` between chunks; on abort, the resolver issues a best-effort DELETE on the upstream session URL (Drive `DELETE <session>`, S3 `AbortMultipartUpload`, tus `DELETE <files>`, MS Graph `DELETE <uploadUrl>`).

## What lives outside this README

- The resolver-side contract — file resolution, `responseMode` logic, `byteLength` thresholds — is documented next to the code in [`packages/afps-runtime/src/resolvers/provider-tool.ts`](../../packages/afps-runtime/src/resolvers/provider-tool.ts).
- The `provider_upload` adapter contracts, chunker semantics, and per-protocol error surfaces are documented next to the code in [`runtime-pi/mcp/provider-upload-resolver.ts`](../mcp/provider-upload-resolver.ts) and [`runtime-pi/mcp/upload-adapters/`](../mcp/upload-adapters/).
- Sidecar pool lifecycle, network isolation, parallel container startup, and credential reporting paths are documented in the platform-level [`CLAUDE.md`](../../CLAUDE.md) under "Sidecar Protocol".
- Provider auth modes (`oauth2` / `oauth1` / `api_key` / `basic` / `custom`) and the `credentialHeaderName` / `credentialHeaderPrefix` injection contract live in `@appstrate/connect`.
