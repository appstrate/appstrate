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
- **`sha256`** is computed streaming at write (`createHashingCounter`, optionally with mid-stream byte caps, `Bun.CryptoHasher`) for integrity + agent-output dedup.
- **Attribution** (`user_id` / `end_user_id`, `package_id`) is copied from the container at creation.
- **Casing**: SQL snake_case, Drizzle TS camelCase, wire snake_case **except** the universal DB-convention carve-outs (CASING_CONVENTIONS.md 4b), which stay camelCase on the wire: `id`, `applicationId`, `packageId`, `createdAt`, `expiresAt`. `run_id` and `chat_session_id` are **not** on that list — they stay snake_case domain fields (matching the `notification` DTO's `run_id`). See `docs/CASING_CONVENTIONS.md`.

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
- **`preview_url` / `previewable` / `preview_kind`** (`toDocumentDto`): a `previewable` boolean and a `preview_kind` (`html` | `image` | `pdf` | `text`, or null) ride every row (true / non-null for a readable document of a previewable kind — see "Preview kinds" below), but the signed `preview_url` is minted **only** on the single-document `GET /api/documents/{id}` — list rows carry `previewable` + `preview_kind` and no token (a gallery page must not sign a short-lived token per row; the preview modal refetches the single GET for a fresh token on open). Both flags and the URL are gated on `downloadable`, so a member never receives a working preview link (nor a non-null `preview_kind`) for another member's `user_upload`. The preview token additionally binds the minting actor, and the preview route re-checks it against a `user_upload`'s creator — a hand-crafted token that verifies is still refused (401).

`listDocumentsForActor` (the gallery) applies the same visibility: a member sees every run-contained document in the app (mirroring the org-wide runs list) plus chat-contained documents only from their own sessions; an end-user sees only their own rows (`actorScopeFilter`). Keyset pagination on `(createdAt, id)` DESC.

The cookie-less preview route uses `loadDocumentForPreview` (org-scoped only) — its signed token IS the authorization; for a `user_upload` the token's bound creator must match the document's, so no container re-check is needed while private uploads stay creator-only.

## Quotas, retention, GC (D3, D4)

All quotas are **synchronous at the write** (async quotas are a documented footgun):

- **`DOCUMENT_MAX_FILE_BYTES`** (default 100 MiB) — per-file cap → 413.
- **`ORG_STORAGE_QUOTA_BYTES`** (default unlimited) — per-org byte quota tracked transactionally on `organizations.documents_bytes_used`, re-checked under `FOR UPDATE` inside the commit → 403 `storage_limit_exceeded`. Cloud sets a plan value in the same column (enforcement 100% core, pricing 100% cloud — zero-billing-vocab constraint).
- **`RUN_MAX_OUTPUT_BYTES`** (default 256 MiB) — ceiling on total bytes a single run may publish, enforced mid-stream on the ingestion path.

The S3 write completes **before** the DB commit, so any DB failure deletes the just-written object (`commitDocumentRow`) — bytes are never stranded uncounted.

**Counter drift & reconciliation.** The `documents_bytes_used` counter is maintained transactionally on every `createDocumentFromUpload` / `createDocumentFromStream` / `deleteDocument`. But an FK **cascade** delete (run / chat-session / end-user / application removed) drops `documents` rows _without_ running the app-level decrement, so the counter can drift high over time. `reconcileOrgDocumentBytes()` (documents.ts) recomputes each org's counter from `SUM(documents.size)` and writes the corrected value where it differs; the GC loop runs it once every ~96 sweep ticks (≈ daily). This keeps the **quota a user is charged against exact** even under cascade churn. The transactional maintenance is the hot path; the reconciliation is only the drift safety net.

**S3 orphans (honest guarantee).** The same FK cascade also orphans the corresponding S3 objects. The storage abstraction (`@appstrate/core/storage`) exposes **no list/enumerate operation**, so an object-level orphan sweep is deliberately _not_ implemented (adding a list op speculatively was rejected). Those orphaned objects are dead storage — a cost, not a correctness or quota problem, since the counter reconciliation above keeps the charged quota exact. If a storage-list capability is added later, an object sweep (or explicit document cleanup wired into the run/chat-session delete service paths) can reclaim them.

**Retention**: default permanent (`expires_at` null). `DOCUMENT_RETENTION_DAYS` (default unset) stamps a default `expires_at` at creation (operator-set instance policy, GitLab pattern). `cleanupExpiredDocuments` sweeps the partial index (`WHERE expires_at IS NOT NULL`) every 15 min (`startDocumentGc`, wired in `boot.ts`), batch-deleting S3 objects + rows and folding the bytes back into each org's counter. This retention sweep is the one path that deletes _both_ object and row (so it leaves no orphan); FK cascades bypass it (see above).

## Inbound flow — upload → document

1. `POST /api/uploads` stages an upload; `PUT` streams the bytes into the ephemeral `uploads` bucket.
2. On consumption (`upload://` in a run input, or a chat attachment), `createDocumentFromUpload` streams `uploads` → `documents` bucket (hashing on the fly, reusing `consumeUploadStream` for size + magic-byte MIME validation), inserts the row, and increments the quota — transactionally.
3. The persisted run input is rewritten `upload://upl_x` → `document://doc_y` (durable source of truth). `materializeRunUploads` runs after the run row exists; a failure rolls back the batch and fails the run loudly.

## Outbound flow — agent → document

- **`POST /api/runs/:runId/documents`** (`routes/runs-events.ts`) — guarded by `verifyRunUploadSignature` (sink HMAC over an empty body, agent-side), streaming raw bytes with metadata via headers. `createDocumentFromStream` enforces the per-file + per-run caps mid-stream (`createHashingCounter` with caps), the org quota transactionally, and dedups by `(run, sha256, name)` for at-least-once retries. Dedup is enforced in two layers: a fast-path pre-commit SELECT, and — for the concurrent-publish race where both callers pass that SELECT — a partial **unique index** `(run_id, sha256, name) WHERE purpose = 'agent_output'`, whose violation the commit path catches and resolves to the same existing row (dedup 200). A genuinely new publish (201) also emits a **`document.published`** audit event attributed to the run's actor; a dedup replay (200) does not.
- **`publish_document` runtime tool** (opt-in via `manifest.runtime_tools`) — reads a workspace file, POSTs it to that route (signed), and emits the canonical **`document.published`** event via `_meta["dev.appstrate/events"]`. Unlike the pure event-emitter runtime tools it has an injected HTTP uploader (built in the entrypoint, not `buildRuntimeToolDefs`).
- **`workspace/outputs/` sweep** — at finalize the entrypoint uploads any not-yet-published file in `outputs/` (dedup by sha256), emitting the events before `events/finalize` (OpenAI annotation-loss lesson).

`document.published` is ingested into a `run_log` and forwarded over SSE (`run_update` / `run_log`), so run page and chat cards update live.

## Preview security (D5)

Previewable documents are served **only** from a hardened, cookie-less route, `GET /preview/documents/:id` — mounted **outside `/api`, before the auth pipeline**, so no cookie/API-key/org middleware ever touches it. Shared layers (every kind):

- **Token-only auth**: a short-lived signed token in the URL (`?t=`, `PREVIEW_TOKEN_TTL_SECONDS` = 300), minted by `GET /api/documents/:id` (`mintPreviewUrl`), verified constant-time, bound to one document id. No session is read; a request without a token is 401. Never sets a cookie.
- **Hardening headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, COOP `same-origin`, CORP tuned to same-origin vs cross-origin serving.
- **10 MiB cap** (`PREVIEW_MAX_BYTES`) and the **S1 creator gate** (a `user_upload` preview is refused unless the token's bound minting actor matches the document's creator) apply to all kinds.
- **Separate origin (optional)**: `USERCONTENT_URL` points a second registrable domain (eTLD+1) at the same server → the browser gives the preview its own cookie jar, storage partition, and process (site isolation). When set, `preview_url` is minted on that origin. Cloud always sets it; absent, previews are served same-origin on `APP_URL` (still fully hardened).

### Preview kinds

A document's mime is classified by `previewKind()` (one source of truth for `preview_kind`, `previewable`, and the route's serving branch):

| `preview_kind` | Mimes                                                         | Served as                                                                                                                                                     | Frontend render                            |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `html`         | `text/html`                                                   | Buffered, `<meta>` CSP injected, strict CSP header (`script-src`/`style-src 'unsafe-inline'`), full `Permissions-Policy`                                      | `sandbox="allow-scripts"` iframe           |
| `image`        | `image/png`, `image/jpeg`, `image/gif`, `image/webp`          | Streamed, stored mime, `inline`, `default-src 'none'` CSP                                                                                                     | `<img>`                                    |
| `pdf`          | `application/pdf`                                             | Streamed, stored mime, `inline`, `default-src 'none'` CSP                                                                                                     | **sandboxless** `<iframe>` (native viewer) |
| `text`         | `text/plain`, `text/markdown`, `text/csv`, `application/json` | Streamed, **always relabelled `text/plain; charset=utf-8`**, `inline`, `default-src 'none'` CSP (client-side `fetch()` allowed by the global CORS middleware) | `fetch()` → `<pre>`                        |
| (null)         | everything else                                               | 404 (indistinguishable from not-found)                                                                                                                        | download only                              |

- **HTML** is the only ACTIVE-content kind and keeps the full treatment: a strict `Content-Security-Policy` header **and** a parse-time `<meta http-equiv>` CSP injected as the first child of `<head>` (`injectMetaCsp`) — covers the relative-URL / `srcdoc` bypass a header alone can miss.
- **Inert kinds** (`image`/`pdf`/`text`) cannot execute in the embedding origin, so they stream byte-for-byte with a minimal `default-src 'none'; frame-ancestors <app>` CSP (belt-and-braces). Content-Type is fixed **per kind**, never blindly echoed: text is **always** relabelled `text/plain` (killing any markdown→HTML sniff), image/pdf carry their stored mime. The stored mime is agent-declared, but `nosniff` makes the browser trust the declared type — so a body mislabelled `application/pdf` that is actually HTML renders as a broken PDF in the native viewer, **never** as active HTML.
- **PDF sandbox rationale**: Chrome refuses to render its native PDF viewer inside a sandboxed iframe without `allow-same-origin`, and loosening the HTML sandbox is not an option. So the frontend renders PDFs in a **sandboxless** `<iframe>` pointing at the token URL. This is safe: a PDF is not active content in the embedding origin (browser-native viewer, no script access to the parent), and the response carries `nosniff` + `inline` + `default-src 'none'`. The sandboxless branch is entered ONLY for the `pdf` kind, and the mime-smuggling defense above closes the "HTML mislabelled as PDF" path.
- **SVG decision**: `image/svg+xml` is **deliberately excluded** (not previewable — downloadable only). An SVG is scriptable active content (`<script>`, event handlers), so it is NOT inert like a raster image; routing it safely would require the full HTML-style CSP + `sandbox="allow-scripts"` treatment. Rather than grow that machinery for a rare case, SVG is simply not classified as a preview kind.
- **Frontend**: `<DocumentPreview>` branches on `preview_kind`. The `html` iframe uses `sandbox="allow-scripts"` — never `allow-same-origin`, never top-navigation / popups / forms / modals; the `pdf` iframe is sandboxless (above); `image` uses `<img>`; `text` is `fetch()`ed and shown in a `<pre>` (no execution). A regression test pins the html sandbox to exactly `allow-scripts` and asserts `sandbox=` appears only once in the component (the pdf iframe stays sandboxless).

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
