# Sidecar — credential-isolating HTTP proxy

A small Hono server that runs in its own Docker container alongside every Appstrate agent run. The agent container talks to the sidecar over the run's private bridge network; the sidecar holds the credentials, talks to upstream provider APIs, and returns the response bytes back to the agent.

The agent container has no platform credentials, no access to `host.docker.internal`, and no `SIDECAR_URL` env var after bootstrap (Phase 2e). All sidecar-backed capabilities are exposed to the agent LLM as typed Pi tools — never as a bare URL.

## Endpoints

- `GET /health` — Readiness check. Returns 200 when the forward proxy is ready, 503 (`{ status: "degraded" }`) otherwise.
- `POST /configure` — One-time runtime configuration for pool-pre-warmed sidecars (`runToken`, `platformApiUrl`, `proxyUrl`, optional `llm`). Authenticated via `Bearer ${CONFIG_SECRET}` and locked after first use. Permanently locked when the sidecar was started fresh with `RUN_TOKEN` already in the environment.
- `ALL /proxy` — The credential-injecting transparent proxy. Routes via `X-Provider` + `X-Target` headers, validates the resolved URL against the provider's `authorizedUris`, applies SSRF blocklist, injects the credential header server-side, and forwards bytes both ways.
- `ALL /llm/*` — LLM reverse proxy for the agent's model calls. Replaces the SDK's placeholder API key with the real key, streams the response zero-copy.
- `GET /run-history` — Thin pass-through to the platform's `/internal/run-history` (authorized via `RUN_TOKEN`).

## Binary safety

`/proxy` reads the request body as `c.req.arrayBuffer()` and returns the upstream body via `targetRes.arrayBuffer()`. Both directions are byte-exact — no `.text()` decode, no UTF-8 round-trip, no implicit Content-Type rewriting. This was originally regressed in #149 and re-fixed in #151; the binary roundtrip suite in `test/app.test.ts` (`describe("binary roundtrip via /proxy")`) pins the contract end-to-end.

The only path that decodes the request body to UTF-8 is the optional `X-Substitute-Body: true` header, which performs `{{variable}}` placeholder substitution. Without that header, the body is forwarded as raw bytes.

## Size limits

| Constant                     | Value  | Header override       | Purpose                                                          |
| ---------------------------- | ------ | --------------------- | ---------------------------------------------------------------- |
| `MAX_RESPONSE_SIZE`          | 256 KB | `X-Max-Response-Size` | Default cap on upstream response bytes returned to the agent.    |
| `ABSOLUTE_MAX_RESPONSE_SIZE` | 1 MB   | (hard cap)            | Ceiling on `X-Max-Response-Size` regardless of header value.     |
| `MAX_SUBSTITUTE_BODY_SIZE`   | 5 MB   | —                     | Maximum buffered request body size accepted by `/proxy`.         |
| `STREAMING_THRESHOLD`        | 1 MB   | (auto)                | Above this `Content-Length` `/proxy` switches to streaming mode. |
| `MAX_STREAMED_BODY_SIZE`     | 100 MB | (hard cap)            | Ceiling on streamed request and response bodies.                 |
| `OUTBOUND_TIMEOUT_MS`        | 30 s   | —                     | Upstream `/proxy` request timeout.                               |
| `LLM_PROXY_TIMEOUT_MS`       | 5 min  | —                     | `/llm/*` request timeout (long enough for streamed completions). |

When the upstream response exceeds the effective cap, the sidecar returns the prefix and sets `X-Truncated: true`. Agents that legitimately need larger payloads should opt in via `responseMode.toFile` on the AFPS provider tool — the runtime resolver then sets `X-Stream-Response: 1` and the sidecar pipes upstream bytes through without truncation.

## Streaming pass-through (PR-4)

`/proxy` supports two opt-in streaming paths to keep memory bounded on large binary uploads (Drive resumable uploads ≥ 8 MiB) and downloads (Drive media exports, build artifacts):

- **Request side** — When the incoming `Content-Length` exceeds `STREAMING_THRESHOLD` (1 MB) AND `X-Substitute-Body` is unset, the sidecar pipes the body directly to upstream with `duplex: "half"`. No buffering. Upper-bounded at `MAX_STREAMED_BODY_SIZE` (100 MB) — over-sized uploads return 413 before the upstream socket opens.

- **Response side** — When the caller sets `X-Stream-Response: 1`, the sidecar returns a zero-copy `Response` wrapping `targetRes.body`. No buffering, no truncation. The sidecar enforces `MAX_STREAMED_BODY_SIZE` up front via the upstream `Content-Length` header when present; chunked / unknown-size responses fall back on the 30 s outbound timeout.

- **401 in streaming-request mode** — The request body has already been consumed by the first upstream call and cannot be replayed. The sidecar still refreshes the credentials (so the _next_ idempotent retry succeeds) and surfaces the 401 with `X-Auth-Refreshed: true`. The AFPS resolver (`{ fromFile }` is reproducible) interprets this header as "transient, retry me" and re-calls. The transparent retry is preserved on the buffered path (Content-Length below `STREAMING_THRESHOLD`), so non-streaming flows are unaffected.

Streaming is opt-in by request shape — agents that don't need it (the common case) keep the existing buffered semantics with the existing 256 KB / 1 MB / 5 MB caps.

## The `body.fromFile` contract

The AFPS provider tool exposes `body.fromFile` so agents can upload workspace files without ever having to base64-encode them into a JSON tool argument. **The sidecar has no workspace mount and no knowledge of `fromFile`** — that contract is purely runtime-side:

1. The agent calls the provider tool with `{ body: { fromFile: "report.pdf" } }`.
2. The AFPS resolver in `packages/afps-runtime/src/resolvers/provider-tool.ts` reads the workspace bytes locally.
3. The resolver POSTs the raw bytes to `/proxy` as the request body, with the appropriate `Content-Type` and `X-Provider` / `X-Target` headers.
4. The sidecar sees only bytes — by design.

The download counterpart (`responseMode.toFile`) is the same in reverse: the resolver requests a higher `X-Max-Response-Size`, reads the response bytes, and writes them to the workspace before handing a `{ savedTo, byteLength }` summary back to the agent.

## What lives outside this README

- The resolver-side contract — file resolution, `responseMode` logic, `byteLength` thresholds — is documented next to the code in [`packages/afps-runtime/src/resolvers/provider-tool.ts`](../../packages/afps-runtime/src/resolvers/provider-tool.ts).
- Sidecar pool lifecycle, network isolation, parallel container startup, and credential reporting paths are documented in the platform-level [`CLAUDE.md`](../../CLAUDE.md) under "Sidecar Protocol".
- Provider auth modes (`oauth2` / `oauth1` / `api_key` / `basic` / `custom`) and the `credentialHeaderName` / `credentialHeaderPrefix` injection contract live in `@appstrate/connect`.
