# ADR-014 — `provider_upload`: chunked resumable uploads with credential isolation preserved

- **Status:** Accepted
- **Date:** 2026-05-08
- **Author:** Pierre Cabriere (driven by issue #283)
- **Supersedes:** —

## Context

The platform's `provider_call` MCP tool caps request bodies at `MAX_REQUEST_BODY_SIZE` (default 10 MB) for two reasons grounded in the architecture:

1. **JSON-RPC has no native byte type.** Bytes ride over MCP as base64. After ~1.37× inflation plus JSON-RPC overhead, the practical envelope ceiling lands around 12 MiB on a 16 MiB envelope cap (`MAX_MCP_ENVELOPE_SIZE`).
2. **The sidecar buffers the body before forwarding upstream.** Even with streaming, single-envelope MCP can't transit a 50 MB PDF without a refactor that breaks every existing transport assumption.

Above the cap, an agent that wants to upload (e.g.) a 50 MB PDF to Drive is stuck. We surveyed the SOTA (April 2026) — three patterns dominate large-file uploads:

| Pattern                      | Notes                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Presigned URLs (S3/GCS)      | Bypasses the platform entirely. Doesn't fit our model: the agent has no credentials and can't talk to Drive directly. |
| tus / IETF Resumable Uploads | Standard wire format. Chunked PATCH with offset state. Gateway-friendly.                                              |
| MCP File Uploads WG          | Acknowledges the gap; charter explicitly evaluates "streaming, chunked transfer, presigned upload URLs".              |

The common SOTA principle is "don't pipe bytes through the platform" — but our entire value proposition is credential isolation. Bytes _must_ pipe through the sidecar so creds get injected.

## Decision

Add a new Pi tool `provider_upload` that orchestrates chunked resumable uploads **client-side in the runtime**, using the existing `provider_call` MCP tool to dispatch each chunk. The sidecar is unchanged.

```
agent LLM
  │  one tool call (provider_upload)
  ▼
McpProviderUploadResolver  (runtime-pi/mcp/provider-upload-resolver.ts)
  │  reads workspace via resolveSafeFile (lstat-checked, path-safe)
  │  streams via Bun.file().stream() at partSizeBytes granularity
  │
  ├─ provider_call POST /upload?uploadType=resumable
  │    body: metadata JSON (~1 KB)
  │    ← Location: <session URL>          ← surfaced via _meta.appstrate/upstream
  │
  ├─ for chunk in stream(file, 4 MiB chunks):
  │    provider_call PUT <session URL>
  │      headers: Content-Range: bytes <start>-<end>/<total>
  │      body: { fromBytes: <base64 of chunk>, encoding: "base64" }
  │      ← 308 Resume Incomplete (continue) | 200 (final, with file metadata)
  │
  └─ return final upstream response + SHA-256 of bytes committed to the wire
```

Four adapters cover ~95% of real-world chunked-upload providers (Google resumable, S3 multipart, tus, Microsoft Graph resumable). Each adapter implements the `UploadAdapter` interface in `runtime-pi/mcp/upload-adapters/types.ts` (init / uploadChunk / finalize / abort) and is ~100–200 LoC.

### Three preconditions, all landing in the same change

1. **MCP response-header propagation.** Without `Location:` from the resumable session init, no protocol-level chunking works. Headers ride back via `CallToolResult._meta["appstrate/upstream"]: { status, headers }` filtered through an allowlist (`Location`, `ETag`, `Content-Range`, `Upload-Offset`, `Upload-Length`, `Tus-Resumable`, `Retry-After`, `Cache-Control`, …). Cookies / auth challenges stay excluded. Backwards-compat: old clients ignore unknown `_meta` keys per MCP spec, so existing `provider_call` callers are unaffected.

2. **Manifest gating.** Providers opt in via `definition.uploadProtocols: string[]`. The Pi tool is only advertised when ≥1 declared provider supports a known protocol; the LLM-facing `providerId` and `uploadProtocol` enums are constrained to the bundle's actually-supported set. Defence-in-depth re-validation in the runtime rejects (provider, protocol) combinations not declared in the manifest. The AFPS schema's `definition` object is permissive on extra fields (`additionalProperties: {}`) so this works without an upstream `@afps-spec/schema` bump; a follow-up will register the field formally in afps-spec.

3. **Body cap stability.** The sidecar's existing `MAX_REQUEST_BODY_SIZE` (default 10 MB, env-configurable since PR #287) accommodates every adapter's chunk size after base64 inflation: Google 8 MiB → ~11 MiB on the wire, S3 5 MiB minimum → ~6.7 MiB, tus 4 MiB → ~5.4 MiB, MS Graph 5 MiB → ~6.7 MiB. No sidecar changes needed.

## Why not "chunking inside the sidecar"

The sidecar has no workspace mount by AFPS contract (`runtime-pi/sidecar/README.md` §"The body.fromFile contract"). Mounting the workspace into the sidecar would break the credential-isolation invariant the whole architecture is built on (ADR-003). Bytes must originate from the agent container.

## Why not a new MCP transport (streaming-native)

Future work, but not required here. The chunked-orchestration design works on top of stateless Streamable HTTP without changes. When (if) the MCP File Uploads WG ships a streaming-native transport, this code path becomes the fallback for non-streaming sidecars.

## Why one resolver, four adapters (vs four tools)

The agent's mental model is "upload this file via this protocol". The same resolver entry point yielding `{ ok, status, headers, body, sha256, size, chunks }` regardless of protocol is uniform — easier to reason about, easier to test. Per-protocol differences (Google's mid-upload 308, S3's `<Error>`-in-200 quirk, tus's `Upload-Offset` tracking, MS's nested JSON `uploadUrl`) are encapsulated in adapter-private state and surface uniformly to the LLM.

## Consequences

### Positive

- Files up to `MAX_STREAMED_BODY_SIZE` (default 100 MB) become uploadable to the supported providers without architectural changes.
- The runtime never holds more than one chunk in memory; the sidecar buffers one chunk per `provider_call`. End-to-end memory profile is bounded.
- The header-propagation change is independently useful — agents can now drive resumable uploads themselves by chaining `provider_call`s, even without `provider_upload` (the issue's "option A").
- SHA-256 streaming + the agent surface returning the digest gives post-upload byte-equivalence verification for free.

### Negative

- Each chunk is a separate authenticated round-trip through the sidecar. For a 100 MB file at 4 MiB chunks that's 25 + 1 round-trips. At ~50 ms RTT per chunk against a real upstream that's ~1.3 s of orchestration overhead — acceptable for a tool that exists precisely because the file is too large for a single shot.
- Cross-run resume is explicitly **out of scope**. Drive sessions live 7 days, S3 multipart uploads live ~7 days too, but persisting the session ID across runs drifts toward stateful long-running ops that need a different design entirely.
- Each new protocol (e.g. Slack, Box, Dropbox) is a new ~100 LoC adapter file. The adapter interface keeps the per-protocol delta small but not zero.

### Out of scope (deferred)

- **Cross-run resume.** Would need DB persistence of session URLs.
- **Server-side upload (sidecar with workspace mount).** Explicitly rejected — breaks the isolation invariant.
- **New MCP transport (streaming-native).** Future work.
- **Download counterpart improvements.** `responseMode.toFile` already works for `resource_link` blocks up to `ABSOLUTE_MAX_RESPONSE_SIZE` (32 MB) via the BlobStore.
- **Formal AFPS schema bump.** `definition.uploadProtocols` is accepted via the existing `additionalProperties: {}` permissive shape; a follow-up will register it in `@afps-spec/schema`.

## References

- Issue [#283](https://github.com/appstrate/appstrate/issues/283) — full SOTA review, design discussion.
- [MCP File Uploads Working Group charter](https://modelcontextprotocol.io/community/file-uploads/charter)
- [Google Drive resumable upload reference](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable)
- [AWS S3 multipart upload reference](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [tus 1.0.x protocol](https://tus.io/protocols/resumable-upload)
- [Microsoft Graph createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)
- ADR-003 — Sidecar credential isolation (the invariant this design preserves).
