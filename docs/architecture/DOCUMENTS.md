# Documents Platform

The durable, first-class document store: user uploads that runs consume and deliverables that agents publish, addressed by a stable opaque `document://` URI, with access inherited from the container (run or chat session). Bidirectional — bytes flow **into** runs (user attachments) and **out of** runs (agent outputs) — and chainable: a `document://` produced by run A can be fed into run B.

Core code: `apps/api/src/services/documents.ts` (service), `apps/api/src/routes/documents.ts` (routes + preview), `apps/api/src/services/document-preview.ts` (preview tokens + CSP), `packages/db/src/schema/documents.ts` (schema).

## Model

One unified table (`documents`) holds both origins, discriminated by `purpose`:

| `purpose`      | Origin                                                                     | Container                     | Downloadable by                   |
| -------------- | -------------------------------------------------------------------------- | ----------------------------- | --------------------------------- |
| `user_upload`  | A staged upload materialized on first consumption by a run or chat session | `run_id` or `chat_session_id` | its creator only                  |
| `agent_output` | A deliverable an agent published from a run                                | `run_id`                      | anyone who can read the container |

Key facts:

- **`downloadable` is derived, never stored** (`deriveDownloadable`): an `agent_output` is downloadable by anyone who can read the container; a `user_upload` only by its own creator — so an upload is never re-served to other actors via the API (kills the CDN-abuse vector). The `/content` route enforces it; `toDocumentDto` surfaces it.
- **`sha256`** is computed streaming at write (`createHashingCounter` / `createCappedHashingCounter`, `Bun.CryptoHasher`) for integrity + agent-output dedup.
- **Attribution** (`user_id` / `end_user_id`, `package_id`) is copied from the container at creation.
- **Casing**: SQL snake_case, Drizzle TS camelCase, wire snake_case except the universal id/timestamp carve-outs (`id`, `run_id`, `created_at`…). See `docs/CASING_CONVENTIONS.md`.

## URI scheme

`document://doc_<nanoid>` — opaque, **stable for the document's lifetime, never re-minted** (D6). This is the claim-check the whole platform passes around: the input-parser resolves it, chat messages store only it (never the ephemeral `upload://`), and MCP exposes it as a `resource_link`. `parseDocumentUri` validates the `doc_` + ≥8-char id shape before any DB hit.

Contrast with the ephemeral `upload://upl_x` staging handle: uploads have a short TTL (`UPLOAD_RETENTION_HOURS`) and exist only for the PUT-then-consume window; once consumed, the durable `document://` takes over (so `rerun_from` re-resolves `document://`, no longer bound to the upload retention window).

## ACL — inherited from the container (D2, D7)

No per-file grants. `getDocumentForActor` derives access at check time:

- **`run_id` container** → the run's read semantics: org+app scope match, plus the end-user guard (`row.endUserId !== actor.id → notFound` for an end-user actor), mirroring `routes/runs.ts`.
- **`chat_session_id` container** → chat sessions are per dashboard user; only the owner reads.
- A cross-org, cross-app, or cross-actor id is **indistinguishable from a missing one** (returns null → 404).

**Cross-actor references honour `deriveDownloadable` (a `user_upload` is creator-only content).** Because a run is org-wide-visible to members, container resolution alone would let member B reference member A's private upload. So both surfaces that hand a document to a _different_ actor's context gate on `downloadable`, not just container ACL:

- **`document://` run input** (`input-parser`): after `getDocumentForActor`, a `user_upload` whose creator is not the resolving run actor is **rejected as not-found** (404) — a member cannot deliver another member's upload into their own run. An `agent_output` stays freely referenceable by anyone who can read the run (the intended chaining case, D6). A chat-contained upload passes trivially: its creator is the chat user, who is the run actor.
- **`preview_url`** (`toDocumentDto`): minted **only** when the caller is `downloadable`, so a member never even receives a working preview link for another member's `user_upload`. The preview token additionally binds the minting actor, and the preview route re-checks it against a `user_upload`'s creator — a hand-crafted token that verifies is still refused (401).

`listDocumentsForActor` (the gallery) applies the same visibility: a member sees every run-contained document in the app (mirroring the org-wide runs list) plus chat-contained documents only from their own sessions; an end-user sees only their own rows (`actorScopeFilter`). Keyset pagination on `(createdAt, id)` DESC.

The cookie-less preview route uses `loadDocumentForPreview` (org-scoped only) — its signed token IS the authorization; for a `user_upload` the token's bound creator must match the document's, so no container re-check is needed while private uploads stay creator-only.

## Quotas, retention, GC (D3, D4)

All quotas are **synchronous at the write** (async quotas are a documented footgun):

- **`DOCUMENT_MAX_FILE_BYTES`** (default 100 MiB) — per-file cap → 413.
- **`ORG_STORAGE_QUOTA_BYTES`** (default unlimited) — per-org byte quota tracked transactionally on `organizations.documents_bytes_used`, re-checked under `FOR UPDATE` inside the commit → 403 `storage_limit_exceeded`. Cloud sets a plan value in the same column (enforcement 100% core, pricing 100% cloud — zero-billing-vocab constraint).
- **`RUN_MAX_OUTPUT_BYTES`** (default 256 MiB) — ceiling on total bytes a single run may publish, enforced mid-stream on the ingestion path.

The S3 write completes **before** the DB commit, so any DB failure deletes the just-written object (`commitDocumentRow`) — bytes are never stranded uncounted.

**Retention**: default permanent (`expires_at` null). `DOCUMENT_RETENTION_DAYS` (default unset) stamps a default `expires_at` at creation (operator-set instance policy, GitLab pattern). `cleanupExpiredDocuments` sweeps the partial index (`WHERE expires_at IS NOT NULL`) every 15 min (`startDocumentGc`, wired in `boot.ts`), batch-deleting S3 objects + rows and folding the bytes back into each org's counter. Run deletion cascades the rows via FK; orphan S3 objects are best-effort reclaimed.

## Inbound flow — upload → document

1. `POST /api/uploads` stages an upload; `PUT` streams the bytes into the ephemeral `uploads` bucket.
2. On consumption (`upload://` in a run input, or a chat attachment), `createDocumentFromUpload` streams `uploads` → `documents` bucket (hashing on the fly, reusing `consumeUploadStream` for size + magic-byte MIME validation), inserts the row, and increments the quota — transactionally.
3. The persisted run input is rewritten `upload://upl_x` → `document://doc_y` (durable source of truth). `materializeRunUploads` runs after the run row exists; a failure rolls back the batch and fails the run loudly.

## Outbound flow — agent → document

- **`POST /api/runs/:runId/documents`** (`routes/runs-events.ts`) — guarded by `verifyRunSignature` (sink HMAC, agent-side), streaming raw bytes with metadata via headers. `createDocumentFromStream` enforces the per-file + per-run caps mid-stream (`createCappedHashingCounter`), the org quota transactionally, and dedups by `(run, sha256, name)` for at-least-once retries.
- **`publish_document` runtime tool** (opt-in via `manifest.runtime_tools`) — reads a workspace file, POSTs it to that route (signed), and emits the canonical **`document.published`** event via `_meta["dev.appstrate/events"]`. Unlike the pure event-emitter runtime tools it has an injected HTTP uploader (built in the entrypoint, not `buildRuntimeToolDefs`).
- **`workspace/outputs/` sweep** — at finalize the entrypoint uploads any not-yet-published file in `outputs/` (dedup by sha256), emitting the events before `events/finalize` (OpenAI annotation-loss lesson).

`document.published` is ingested into a `run_log` and forwarded over SSE (`run_update` / `run_log`), so run page and chat cards update live.

## Preview security (D5)

Untrusted, agent-generated HTML is served **only** from a hardened, cookie-less route, `GET /preview/documents/:id` — mounted **outside `/api`, before the auth pipeline**, so no cookie/API-key/org middleware ever touches it. Layers:

- **Token-only auth**: a short-lived signed token in the URL (`?t=`, `PREVIEW_TOKEN_TTL_SECONDS` = 300), minted by `GET /api/documents/:id` (`mintPreviewUrl`), verified constant-time, bound to one document id. No session is read; a request without a token is 401. Never sets a cookie.
- **Double CSP**: a strict `Content-Security-Policy` header **and** a parse-time `<meta http-equiv>` CSP injected as the first child of `<head>` (`injectMetaCsp`) — covers the relative-URL / `srcdoc` bypass a header alone can miss.
- **Hardening headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` cutting camera/mic/geo/payment/usb, COOP `same-origin`, CORP tuned to same-origin vs cross-origin serving.
- **Separate origin (optional)**: `USERCONTENT_URL` points a second registrable domain (eTLD+1) at the same server → the browser gives the preview its own cookie jar, storage partition, and process (site isolation). When set, `preview_url` is minted on that origin. Cloud always sets it; absent, previews are served same-origin on `APP_URL` (still fully hardened).
- **Frontend**: the `<DocumentPreview>` iframe uses `sandbox="allow-scripts"` — never `allow-same-origin`, never top-navigation / popups / forms / modals.

## MCP exposure

The platform MCP server (`apps/api/src/modules/mcp/`) surfaces documents to external clients (claude.ai, …) and to the in-process chat, all through the same forwarded-auth in-process dispatch as the other tools:

- **`run_and_wait`** result carries one **`resource_link`** content block per document the run published (`{type:"resource_link", uri, name, mimeType, size, description}`, spec 2025-06-18), alongside the text payload (which also echoes `documents`, parity with the chat path). Reuses `fetchRunDocuments`.
- **`resources/read`** on a `document://` URI: a textual document (`text/*`, JSON, XML, `+json`/`+xml`) ≤ 1 MiB that the caller may download is inlined as `text`; everything else (non-textual, oversized, not downloadable) returns metadata only. A foreign/unknown id is an MCP error. Documents are **not** listed under `resources/list` (per spec — links need not be enumerated).
- **`list_documents`** tool: the caller-visible documents (reuses `listDocumentsForActor`), filterable by `run_id` / `chat_session_id` / `purpose`, returning compact `{documents:[{id, uri, name, mime, size, run_id, package_id, created_at}], has_more}`. Exposed to chat too (both engines discover it dynamically), so the assistant can retrieve and re-inject a `document://` URI.

## Environment variables

| Variable                  | Default                     | Purpose                                                                      |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `DOCUMENT_MAX_FILE_BYTES` | `104857600` (100 MiB)       | Per-file write cap (413 over-cap).                                           |
| `ORG_STORAGE_QUOTA_BYTES` | unset (unlimited)           | Per-org durable-storage byte quota (403 `storage_limit_exceeded`).           |
| `RUN_MAX_OUTPUT_BYTES`    | `268435456` (256 MiB)       | Total bytes a single run may publish as output.                              |
| `DOCUMENT_RETENTION_DAYS` | unset (permanent)           | Default `expires_at` at creation; drives the GC sweep.                       |
| `USERCONTENT_URL`         | unset (same-origin preview) | Separate registrable domain for serving HTML previews (strongest isolation). |

Preview tokens are signed with `UPLOAD_SIGNING_SECRET` (shared with the uploads subsystem). See `docs/ENV.md` for the authoritative env reference.
