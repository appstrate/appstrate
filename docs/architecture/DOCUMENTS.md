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

**Counter drift & reconciliation.** The `documents_bytes_used` counter is maintained transactionally on every `createDocumentFromUpload` / `createDocumentFromStream` / `deleteDocument`, and on the detach-or-delete teardown of the two user-driven container deletions (D8). The remaining drift source is the **tenant-teardown FK cascade** (end-user / application / org removed), which drops `documents` rows _without_ running the app-level decrement, so the counter can drift high over time. `reconcileOrgDocumentBytes()` (documents.ts) locks each organization row before recomputing its counter from `SUM(documents.size)`; document writes use the same organization lock, so reconciliation cannot overwrite a concurrent increment or decrement. The GC loop runs it once every ~96 sweep ticks (≈ daily). This keeps the **quota a user is charged against exact** even under teardown churn. The transactional maintenance is the hot path; reconciliation is the drift safety net.

**S3 orphans (honest guarantee).** The remaining **tenant-teardown FK cascade** (end-user / application / org removed) still orphans the corresponding S3 objects — the two user-driven container deletions no longer do, since detach-or-delete (D8) purges each deleted doc's object post-commit. The storage abstraction (`@appstrate/core/storage`) exposes **no list/enumerate operation**, so an object-level orphan sweep is deliberately _not_ implemented (adding a list op speculatively was rejected). Those orphaned objects are dead storage — a cost, not a correctness or quota problem, since the counter reconciliation above keeps the charged quota exact. If a storage-list capability is added later, an object sweep can reclaim them.

**Retention**: default permanent (`expires_at` null). `DOCUMENT_RETENTION_DAYS` (default unset) stamps a default `expires_at` at creation (operator-set instance policy, GitLab pattern). `cleanupExpiredDocuments` sweeps the partial index (`WHERE expires_at IS NOT NULL`) every 15 min (`startDocumentGc`, wired in `boot.ts`), batch-deleting S3 objects + rows and folding the bytes back into each org's counter. This retention sweep — like the detach-or-delete teardown (D8) — deletes _both_ object and row (so it leaves no orphan); only the tenant-teardown FK cascades bypass object cleanup (see above).

## Lifecycle & chaining (D8)

A `document://` is **durable and chainable**: an `agent_output` from run A can be fed into run B as input, and must outlive A's deletion. Two pieces of machinery deliver that promise — a consumption ledger and a detach-or-delete teardown — so the two user-driven container deletions leave **no orphan storage objects and no counter drift**.

**Consumption ledger (`document_links`).** Every `document://` resolved as a run input writes a `(document_id, consumer_run_id)` link — the record of "which _other_ runs still need this doc". Run creation locks and revalidates every referenced document in the org+application scope, then inserts the run and its links in **one transaction**. Either all inputs are protected or no run is created (`409 document_unavailable`); there is no resolve/create deletion window. Duplicate ids are deduplicated and link inserts remain idempotent (`onConflictDoNothing`). A run never links to its own outputs (the consumer run is brand-new, so it is never an input doc's own container).

**Detach-or-delete teardown.** The two user-driven container deletions — `DELETE /agents/:pkg/runs` (`deletePackageRuns`) and `DELETE /api/chat/sessions/:id` (the `cleanupSessionDocuments` seam) — no longer let the FK cascade blindly drop contained documents. `detachOrDeleteContainedDocuments` runs **before** the container delete and decides per contained doc:

- **Protected → detach.** A doc a live consumer outside the deleted set still needs (run variant: a `document_links` row whose `consumer_run_id` is not in the deleted run set; chat variant: _any_ link at all — a chat session is never itself a consumer) is **detached**: its container is NULLed, but id, bytes, counter, and storage object are untouched. A rerun of the surviving consumer still resolves the same `document://` URI.
- **Unprotected → delete.** Nothing else references it: the row is deleted **and** the org byte counter decremented in one transaction; the storage object is purged best-effort after commit (same fire-and-forget-with-warn contract as `deleteDocument`).

Explicit `DELETE /api/documents/:id` uses the same row lock and refuses a linked document with `409 document_in_use`. Retention GC likewise skips linked expired documents; once their consumer links disappear, a later sweep can reclaim them.

Because the delete branch decrements the counter and purges the object, these two paths produce **no orphan objects and no counter drift** — they are self-cleaning, unlike the blind tenant-teardown cascades above. The teardown runs in its own transaction, separate from the container delete: a crash between the two is idempotent (a re-attempt finds the docs already handled and finishes the runs/session delete).

**Detached ACL.** A detached doc (both containers NULL — the legal state under `chk_documents_single_container`) has no container to inherit an ACL from, so `getDocumentForActor` falls back to org+app scope plus the end-user guard (an end-user reads only its own rows). On top of that:

- a detached **`user_upload` is creator-only in full** — metadata included: a non-creator is refused at `getDocumentForActor` (resolves to null → 404) and the row is excluded from other members' lists. Deletion never widens a private upload.
- a detached **`agent_output` stays org+app-readable** — exactly the chaining case: run B (any org member who could read run A) can still read and re-consume run A's now-detached output.

**Scope boundary.** Only **run-input consumption** is protected — that is the sole relationship the ledger tracks. A chat message that merely _references_ a deleted run's document is not a consumer; once that run (and its doc) is gone the reference degrades to a clean **404**, the same as a link to a deleted run. And the protection covers only the two user-driven container deletions; **tenant-teardown cascades** (org / application / end-user delete) deliberately keep the blind FK cascade (see "Counter drift" and "S3 orphans" above) — their scale and finality make a per-doc walk pointless, and the daily counter reconciliation is their safety net.

## Native primitive vs import/export integrations (D9)

**Decision.** `document://` is a **native platform primitive** — the canonical store lives in the `documents` table, addressed by the platform's own opaque URI. External repositories (Google Drive, S3, Dropbox, …) are **import/export integrations**, never the canonical store.

**Why the canonical store cannot be an external repository.** The three guarantees the rest of this document relies on are all things only a first-party store can provide:

1. **Container-inherited ACL evaluated at platform check time** (D2/D7). Access is derived from the run/chat container at read time, in the platform's own authorization context. A foreign repository has its own ACL model the platform neither owns nor can evaluate per request against the run/chat container.
2. **Synchronous quota enforcement at the write** (D3). `ORG_STORAGE_QUOTA_BYTES` is re-checked under `FOR UPDATE` inside the write transaction (403 before the bytes land). An external repository enforces its own limits asynchronously, if at all — the platform cannot make a byte-exact admission decision at write time against a store it does not transact with.
3. **Lifelong opaque URI stability + the lifecycle guarantees above** (D6/D8). The `document://` id is stable for life and never re-minted; detach-or-delete keeps a chained doc resolvable across its producer's deletion. External links are mutable, can expire, and can be re-minted or revoked out from under the platform.

An external repository can guarantee none of the three. Integrations therefore stay the right home for the two directions that _do_ cross the boundary: **import** (pull external bytes in → materialize them as a `document://`) and **export** (push a published document out to a repository). The canonical copy — its ACL, its quota, its lifecycle — stays on the platform.

## Inbound flow — upload → document

1. `POST /api/uploads` stages an upload; `PUT` streams the bytes into the ephemeral `uploads` bucket.
2. On consumption (`upload://` in a run input, or a chat attachment), `createDocumentFromUpload` streams `uploads` → `documents` bucket (hashing on the fly, reusing `consumeUploadStream` for size + magic-byte MIME validation), inserts the row, and increments the quota — transactionally.
3. The persisted run input is rewritten `upload://upl_x` → `document://doc_y` (durable source of truth). `materializeRunUploads` runs after the run row exists; a failure rolls back the batch and fails the run loudly.

## Outbound flow — agent → document

- **`POST /api/runs/:runId/documents`** (`routes/runs-events.ts`) — guarded by `verifyRunUploadSignature` (sink HMAC over an empty body, agent-side), streaming raw bytes with metadata via headers. `createDocumentFromStream` enforces the per-file + per-run caps mid-stream (`createHashingCounter` with caps), the org quota transactionally, and dedups by `(run, sha256, name)` for at-least-once retries. Dedup is enforced in two layers: a fast-path pre-commit SELECT, and — for the concurrent-publish race where both callers pass that SELECT — a partial **unique index** `(run_id, sha256, name) WHERE purpose = 'agent_output'`, whose violation the commit path catches and resolves to the same existing row (dedup 200). A genuinely new publish (201) also emits a **`document.published`** audit event attributed to the run's actor; a dedup replay (200) does not.
- **`publish_document` runtime tool** (opt-in via `manifest.runtime_tools`) — reads a workspace file, POSTs it to that route (signed), and emits the canonical **`document.published`** event via `_meta["dev.appstrate/events"]`. Unlike the pure event-emitter runtime tools it has an injected HTTP uploader (built in the entrypoint, not `buildRuntimeToolDefs`).
- **`workspace/outputs/` sweep** — at finalize the entrypoint uploads any not-yet-published file in `outputs/` (dedup by sha256), emitting the events before `events/finalize` (OpenAI annotation-loss lesson). Uploads are bounded-concurrent (3 at a time) and each POST retries (3 attempts) on transient failures (network error, timeout, 5xx, 429 — honouring `Retry-After`); a file abandoned after retries is logged as a dropped deliverable and never blocks finalize.
  - **Hidden files are excluded by default.** The sweep skips any entry whose relative path has a segment starting with `.` — dotfiles like `.env`/`.netrc` and everything under a hidden dir like `.git/`. Since it publishes to a wider, durable, org-visible surface, an agent that inadvertently writes a secret dotfile under `outputs/` must not have it exfiltrated automatically. The explicit `publish_document` tool is unaffected: a deliberate publish of a dotfile is still allowed.

`document.published` is ingested into a `run_log` and forwarded over SSE (`run_update` / `run_log`), so run page and chat cards update live.

## Run report

An agent's user-facing report is **primarily a document**. The convention: the agent writes its markdown report to `outputs/report.md` in the workspace, and the finalize `outputs/` sweep (above) auto-publishes it as an `agent_output` document like every other deliverable.

- **Consultation path**: the run page **Documents** tab lists `report.md`; opening it in the preview modal renders the markdown inline (client-side, sanitized — see "Preview kinds", 1 MiB inline cap). The cookie-less server preview route still serves markdown as inert `text/plain` (the rich render is a modal-side `<Markdown>` render, never the iframe).
- **Compatibility**: the former `report` runtime tool is deprecated and hidden from the new-agent editor, but existing manifests remain valid and the runtime still executes it. Its `report.appended` events continue to populate run logs and the capped `runs.result.text` compatibility field, and the run page renders those legacy reports under Result. New agents should use `outputs/report.md` / `publish_document`.

## Preview security (D5)

Previewable documents are served **only** from a hardened, cookie-less route, `GET /preview/documents/:id` — mounted **outside `/api`, before the auth pipeline**, so no cookie/API-key/org middleware ever touches it. Shared layers (every kind):

- **Token-only auth**: a short-lived signed token in the URL (`?t=`, `PREVIEW_TOKEN_TTL_SECONDS` = 300), minted by `GET /api/documents/:id` (`mintPreviewUrl`), verified constant-time, bound to one document id. No session is read; a request without a token is 401. Never sets a cookie.
- **Hardening headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, COOP `same-origin`, CORP tuned to same-origin vs cross-origin serving.
- **10 MiB cap** (`PREVIEW_MAX_BYTES`) and the **S1 creator gate** (a `user_upload` preview is refused unless the token's bound minting actor matches the document's creator) apply to all kinds.
- **Separate origin (optional)**: `USERCONTENT_URL` points a second registrable domain (eTLD+1) at the same server → the browser gives the preview its own cookie jar, storage partition, and process (site isolation). When set, `preview_url` is minted on that origin. Cloud always sets it; absent, previews are served same-origin on `APP_URL` (still fully hardened).

### Preview kinds

A document's mime is classified by `previewKind()` (one source of truth for `preview_kind`, `previewable`, and the route's serving branch):

| `preview_kind` | Mimes                                                         | Served as                                                                                                                                                     | Frontend render                                                     |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `html`         | `text/html`                                                   | Buffered, `<meta>` CSP injected, strict CSP header (`script-src`/`style-src 'unsafe-inline'`), full `Permissions-Policy`                                      | `sandbox="allow-scripts"` iframe                                    |
| `image`        | `image/png`, `image/jpeg`, `image/gif`, `image/webp`          | Streamed, stored mime, `inline`, `default-src 'none'` CSP                                                                                                     | `<img>`                                                             |
| `pdf`          | `application/pdf`                                             | Streamed, stored mime, `inline`, `default-src 'none'` CSP                                                                                                     | **sandboxless** `<iframe>` (native viewer)                          |
| `text`         | `text/plain`, `text/markdown`, `text/csv`, `application/json` | Streamed, **always relabelled `text/plain; charset=utf-8`**, `inline`, `default-src 'none'` CSP (client-side `fetch()` allowed by the global CORS middleware) | `fetch()` → `<pre>`; **markdown → sanitized rich render** (≤ 1 MiB) |
| (null)         | everything else                                               | 404 (indistinguishable from not-found)                                                                                                                        | download only                                                       |

- **HTML** is the only ACTIVE-content kind and keeps the full treatment: a strict `Content-Security-Policy` header **and** a parse-time `<meta http-equiv>` CSP injected as the first child of `<head>` (`injectMetaCsp`) — covers the relative-URL / `srcdoc` bypass a header alone can miss.
- **Inert kinds** (`image`/`pdf`/`text`) cannot execute in the embedding origin, so they stream byte-for-byte with a minimal `default-src 'none'; frame-ancestors <app>` CSP (belt-and-braces). Content-Type is fixed **per kind**, never blindly echoed: text is **always** relabelled `text/plain` (killing any markdown→HTML sniff), image/pdf carry their stored mime. The stored mime is agent-declared, but `nosniff` makes the browser trust the declared type — so a body mislabelled `application/pdf` that is actually HTML renders as a broken PDF in the native viewer, **never** as active HTML.
- **PDF sandbox rationale**: Chrome refuses to render its native PDF viewer inside a sandboxed iframe without `allow-same-origin`, and loosening the HTML sandbox is not an option. So the frontend renders PDFs in a **sandboxless** `<iframe>` pointing at the token URL. This is safe: a PDF is not active content in the embedding origin (browser-native viewer, no script access to the parent), and the response carries `nosniff` + `inline` + `default-src 'none'`. The sandboxless branch is entered ONLY for the `pdf` kind, and the mime-smuggling defense above closes the "HTML mislabelled as PDF" path.
- **SVG decision**: `image/svg+xml` is **deliberately excluded** (not previewable — downloadable only). An SVG is scriptable active content (`<script>`, event handlers), so it is NOT inert like a raster image; routing it safely would require the full HTML-style CSP + `sandbox="allow-scripts"` treatment. Rather than grow that machinery for a rare case, SVG is simply not classified as a preview kind.
- **Frontend**: `<DocumentPreview>` branches on `preview_kind`. The `html` iframe uses `sandbox="allow-scripts"` — never `allow-same-origin`, never top-navigation / popups / forms / modals; the `pdf` iframe is sandboxless (above); `image` uses `<img>`; `text` is `fetch()`ed and shown in a `<pre>` (no execution). A **markdown** document (`text/markdown` mime, or a `.md` name served text-ish) is instead rendered rich, **client-side**, through the sanitized `<Markdown>` component (`MarkdownPreview` fetches the bytes via the typed client) — the same trust level as any agent-generated content, and the ONLY path that turns markdown into HTML. This deliberately does **not** relax the route's `text/plain` relabelling (the md→HTML sniff defence stays intact); the rich render happens in the modal, not the iframe. It applies below an inline cap (`INLINE_MARKDOWN_MAX_BYTES` = 1 MiB); an oversized `.md` falls back to the plaintext `<pre>`. A regression test pins the html sandbox to exactly `allow-scripts` and asserts `sandbox=` appears only once in the component (the pdf iframe stays sandboxless).

## MCP exposure

The platform MCP server (`apps/api/src/modules/mcp/`) surfaces documents to external clients (claude.ai, …) and to the in-process chat, all through the same forwarded-auth in-process dispatch as the other tools:

- **`run_and_wait`** result carries one **`resource_link`** content block per document the run published (`{type:"resource_link", uri, name, mimeType, size, description}`, spec 2025-06-18), alongside the text payload (which also echoes `documents`, parity with the chat path). Reuses `fetchRunDocuments`.
- **`resources/read`** on a `document://` URI: a textual document (`text/*`, JSON, XML, `+json`/`+xml`) ≤ 1 MiB that the caller may download is inlined as `text`; everything else (non-textual, oversized, not downloadable) returns metadata only. A foreign/unknown id is an MCP error. Documents are **not** listed under `resources/list` (per spec — links need not be enumerated).
- **`list_documents`** tool: the caller-visible documents (reuses `listDocumentsForActor`), filterable by `run_id` / `chat_session_id` / `purpose`, returning compact `{documents:[{id, uri, name, mime, size, run_id, package_id, created_at}], has_more}`. Exposed to chat too (both engines discover it dynamically), so the assistant can retrieve and re-inject a `document://` URI.

## Hardening

A cross-cutting summary of the guarantees the sections above rely on, and where they are enforced. The details are in the referenced sections; this is the map.

### Identity model — display name vs workspace name (D-naming)

Two distinct names per document:

- **display name** (`documents.name`) — the human name shown to the agent and the gallery. It may legitimately COLLIDE (two inputs both `report.pdf`); the platform never rejects a duplicate display name.
- **workspace name** — the single filename actually written into the run container at `workspace/documents/<name>`, which MUST be unique within the run or one input silently overwrites another. `assignWorkspaceNames` (`run-document-naming.ts`) derives a unique, deterministic name per input by inserting a numeric suffix before the extension (`report.pdf`, `report-2.pdf`), so repeated manifest fetches are stable. `assertUniqueWorkspaceNames` is the invariant guard (400 `duplicate_document_name`) for a hand-built/corrupted manifest — the platform never produces a colliding one.

Agent OUTPUTS dedup on `(run_id, sha256, name)`: two outputs with the same name but different content are two distinct rows; the same name AND content dedups to one (idempotent republish).

### Artifacts summary contract

At finalize the runtime posts a terminal `artifacts` summary (`runs.artifacts`, validated STRICTLY — a malformed summary is a 400): `{ status: "complete" | "partial", published: number, failed: [{ name, code }] }`. `status: "partial"` means at least one `outputs/` deliverable was LOST; each `failed.code` is one of `file_too_large`, `quota_exceeded`, `conflict`, `upload_failed`. It is INDEPENDENT of the run's own terminal status — a successful run can still be `partial` (e.g. it exceeded the org quota on the 2nd of 3 outputs). Absent on older containers (column stays null).

### Deletion outbox (transactional purge)

Every document-row delete whose bytes live in storage enqueues a `storage_deletion_jobs` row **in the same transaction** (`enqueueStorageDeletion`) — atomic with the delete, so a committed delete always leaves a durable, replayable record of the object to purge (supersedes the older best-effort post-commit delete described under D4/D8). A background worker (`processStorageDeletionJobs`, every `STORAGE_DELETION_WORKER_INTERVAL_MS`) claims due jobs with a **lease** (it pushes `next_attempt_at` forward by `CLAIM_LEASE_MS` under `FOR UPDATE SKIP LOCKED` — the timestamp advance IS the lease, no extra column), calls `storage.deleteFile` OUTSIDE any transaction (a slow backend must never pin an idle-in-transaction connection), then settles each job: success → `completed_at`; failure → `attempts + 1` + jittered exponential backoff (`computeBackoffMs`, cap 6h). `deleteFile` is idempotent on a missing object, so a crash between execute and settle re-runs cleanly once the lease expires.

Deletion is **replayable forever** — there is NO max-attempts abandon. Past `STORAGE_DELETION_DEAD_LETTER_THRESHOLD` (8) attempts a still-pending job surfaces as a **dead letter** (operator surface + metric) while it keeps retrying at the capped interval: a persistently-failing purge is a visibility problem, never a reason to drop the job. The admin surface (`routes/admin-storage-deletion.ts`) lists jobs by `pending | dead | completed` (keyset-paginated) and offers a "retry now" (`retryStorageDeletionJob`, resets `next_attempt_at`). The counter (`documents_bytes_used`) is decremented at ROW-delete time, not purge time, so the quota is exact regardless of purge lag.

The **tenant-teardown FK cascade** (org / application / end-user delete) still bypasses this (it drops rows directly) — those object orphans are reclaimed by the `scripts/` orphan-sweep + the daily counter reconciliation (see D3/D4). See also `_resetStoreForTesting` (`packages/db/storage.ts`) — the test seam that lets a suite flip the store's presigned posture.

### Capability matrix (D2 + upload privacy)

`getDocumentCapabilities(doc, actor, { visible, canManage })` is the ONE access computation every consumer (REST route, DTO serializer, preview mint, MCP `resources/read`) derives its gates from — no ad-hoc re-derivation:

| purpose        | `visible` (container ACL) | `metadata` (real name/mime/sha256) | `download` (bytes) | `preview`              | `keep` / `delete`             |
| -------------- | ------------------------- | ---------------------------------- | ------------------ | ---------------------- | ----------------------------- |
| `agent_output` | any container reader      | ✅ any reader                      | ✅ any reader      | ✅ if previewable mime | creator OR `documents:delete` |
| `user_upload`  | any container reader      | ✅ creator only                    | ✅ creator only    | ✅ creator + mime      | creator OR `documents:delete` |

A non-creator run reader of a `user_upload` stays `visible` but gets an **opaque reference**: `projectDocumentMetadata` degrades the DTO/MCP read to a generic name (`document`) + mime (`application/octet-stream`) with **no sha256**, and `/content` is a 403 with **no `Repr-Digest`**. This kills the cross-member disclosure + CDN-abuse vectors. The `documents:delete` management permission grants lifecycle control ONLY — never metadata or bytes of another member's upload.

### Quota resolution order

`effectiveOrgStorageLimit(orgLimit, envQuota)` resolves the per-org ceiling as `organizations.documents_bytes_limit ?? ORG_STORAGE_QUOTA_BYTES ?? unlimited`. The per-org override wins (a hard `0` is honored, not treated as unset); `setOrgDocumentStorageLimit` (the `PlatformServices.setDocumentStorageLimit` capability the cloud module pilots) sets/clears it — billing-neutral (a byte ceiling, never a plan or price). Enforced through one seam (`assertWithinOrgQuota`): a pre-flight fast reject on the declared size AND a re-check under the org `FOR UPDATE` lock at commit, so concurrent writes serialize and each observes the other's committed bytes.

### Upload integrity + staging budgets (inbound)

Staged uploads (the `uploads` bucket) are bounded on three axes before they ever materialize: `UPLOAD_MAX_ACTIVE_PER_ACTOR` (count of live staged uploads per actor, 429 on the N+1th), `UPLOAD_STAGING_MAX_BYTES_PER_ORG` (summed declared sizes of an org's active staging, 403 — distinct from the DURABLE quota), and `RUN_MAX_DOCUMENTS` (per-run input + output document COUNT, 413 `document_count_exceeded`). Integrity: a client may declare a `sha256`, which on the presigned path is signed into the PUT as `x-amz-checksum-sha256` so S3/MinIO verify the bytes server-side (mismatch → 4xx); on the proxy path the platform hashes on the fly. The authoritative digest is exposed as an RFC 9530 `Repr-Digest` on `/content` (only to a caller with the `metadata` capability). Uploads are also validated by magic-byte MIME sniff, and staging is swept after `UPLOAD_RETENTION_HOURS`.

### Metrics

The telemetry façade (`@appstrate/core/telemetry`, backed by `@appstrate/module-observability` when installed; a true no-op otherwise) emits documents counters at the service seams:

| Metric                                     | Attributes | Emitted at                                                                           |
| ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| `appstrate.documents.created`              | `purpose`  | `commitDocumentRow` (the sole commit seam — a dedup replay never counts).            |
| `appstrate.documents.deleted`              | —          | Every row removed: explicit delete, container detach-or-delete, retention GC.        |
| `appstrate.documents.quota_rejections`     | —          | `assertWithinOrgQuota` — once per logical over-limit write (pre-flight OR re-check). |
| `appstrate.documents.partial_publications` | —          | `finalizeRun` CAS winner, when the artifacts summary `status` is `partial`.          |

These complement the phase-3 storage-deletion gauges (`appstrate.storage_deletion.backlog` / `.oldest_pending_age_seconds` / `.dead_letters` / `.result`). No per-org used/limit gauge — that is a per-org API concern (`GET /organizations/:id`), not a global metric.

## Environment variables

| Variable                              | Default                     | Purpose                                                                                                                    |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DOCUMENT_MAX_FILE_BYTES`             | `104857600` (100 MiB)       | Per-file write cap (413 over-cap).                                                                                         |
| `ORG_STORAGE_QUOTA_BYTES`             | unset (unlimited)           | Global per-org durable-storage byte quota (403 `storage_limit_exceeded`); overridable per org via `documents_bytes_limit`. |
| `RUN_MAX_OUTPUT_BYTES`                | `268435456` (256 MiB)       | Total bytes a single run may publish as output.                                                                            |
| `RUN_MAX_DOCUMENTS`                   | `200`                       | Per-run input + output document COUNT cap (413 `document_count_exceeded`).                                                 |
| `DOCUMENT_RETENTION_DAYS`             | unset (permanent)           | Default `expires_at` at creation; drives the GC sweep.                                                                     |
| `UPLOAD_MAX_ACTIVE_PER_ACTOR`         | `50`                        | Max live (unconsumed, unexpired) staged uploads per actor (429 on the N+1th).                                              |
| `UPLOAD_STAGING_MAX_BYTES_PER_ORG`    | `2147483648` (2 GiB)        | Ceiling on an org's active staging (ephemeral `uploads` bucket); 403 over-budget.                                          |
| `UPLOAD_RETENTION_HOURS`              | `24`                        | Staged-upload TTL before the sweep reclaims it.                                                                            |
| `STORAGE_DELETION_WORKER_INTERVAL_MS` | `60000` (60 s)              | Cadence of the storage-deletion outbox worker.                                                                             |
| `USERCONTENT_URL`                     | unset (same-origin preview) | Separate registrable domain for serving HTML previews (strongest isolation).                                               |

Preview tokens are signed with `UPLOAD_SIGNING_SECRET` (shared with the uploads subsystem). `STORAGE_DELETION_DEAD_LETTER_THRESHOLD` (8) is a code constant, not an env var. See `docs/ENV.md` for the authoritative env reference.
