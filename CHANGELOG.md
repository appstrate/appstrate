# Changelog

All notable changes to Appstrate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **BREAKING: `document` is now `file`, everywhere the concept is named
  (#1177) — and the compatibility layer the rename shipped with is gone.**
  `publish_document` accepted Markdown, HTML, source code, a PDF, an image —
  anything on the agent's filesystem — but "document" promises a Word or a PDF
  to whoever reads the tool description, the model included. The word was a
  false friend, so the concept is renamed from the schema to the wire.

  The rename first shipped a READ alias on every wire-visible spelling, each
  one justified by a single sentence: "the runtime image and the platform
  deploy independently". `v1.0.0-beta.51` is precisely the artifact on the
  other side of that sentence, and it speaks every retired shape: it registers
  `/api/runs/{runId}/documents` and `/api/runs/{runId}/documents/{name}` and
  not one `/files` route; `runtime-pi/publish.ts` posts each deliverable to
  `…/documents` under `X-Document-Name`; `runtime-pi/provision.ts` fetches its
  input manifest from `…/documents`; `packages/afps-runtime/src/events/cloudevents.ts`
  stamps `dataschema` on every canonical event; and its row ids are `doc_`. So
  the argument for deleting the layer is NOT that nobody ever spoke the old
  shapes — the last release did. It is that the PAIRING of such an artifact
  with this platform is now refused at boot: the environment schema will not
  start unless the platform's own `APP_VERSION` and both runtime image tags
  agree (see the entry below), so an old image cannot be _configured_ against
  a new platform.

  **That rule has blind spots, and they are the whole residual risk.** They
  come in two kinds. The comparison carves itself out wherever a tag cannot
  answer the question — a runtime ref pinned by digest alone silences it
  outright (`findRuntimeImageTagMismatch` returns `null` the moment either ref
  parses to no tag), and a platform with no release identity drops out of the
  trio, degrading the rule to the image-pair rule it grew from; the
  authoritative list of those carve-outs lives with the comparison in
  `@appstrate/core/image-ref`. And then there is the one that is not a carve-out
  at all: this is an env-schema check evaluated at BOOT, so it says nothing
  whatsoever about containers **already running** when the platform restarts.
  (Same-tag-two-builds drift — `:latest` rebuilt on one side — is invisible to
  tag comparison by construction; `runtime-image-pair.ts` catches it from the
  OCI revision labels after the pre-pull, and only WARNS.)

  That second kind is the operational one, and it needs a step in the upgrade
  rather than a paragraph. A run container started by the PREVIOUS
  platform process survives a `compose up -d`: the boot sweep finalizes only
  runs whose heartbeat has already gone stale (`listOrphanRunIds`, cutoff
  `RUN_STALL_THRESHOLD_SECONDS`), and the container sweep preserves anything in
  state `running` (`isReclaimableContainer`); a container still executing a run
  satisfies neither reap condition. It keeps posting to the new API, and its
  `POST …/documents` now
  404s. In the uploader a 404 is a non-retryable 4xx, so the deliverable is
  abandoned and the outputs sweep reports `artifacts.status: "partial"`. That
  field is not an input to the run's status — `mapTerminalStatus` reads only
  `result.status` / `result.error` — so **a run whose work succeeded still
  settles `success`, with its deliverable simply missing**, which is the exact
  silent failure the aliases existed to prevent. **Drain in-flight runs before
  restarting the platform**; see OPERATOR ACTIONS below.

  What is verified about released consumers is narrower, and holds: the
  released CLI never called the retired paths, neither `cloud` nor
  `connect-helper` contains any retired wire shape, and the SPA is baked into
  the platform image, so a served build cannot be older than the platform
  serving it. The layer is deleted, not deprecated.

  | Surface             | Before                                                                                    | After                                                                     |
  | ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | Runtime tool        | `publish_document`                                                                        | `publish_file`                                                            |
  | URI scheme          | `document://<id>`                                                                         | `appfile://<id>`                                                          |
  | REST                | `/api/documents/*`, `/api/runs/{id}/documents[/{name}]`, `/preview/documents/{id}`        | `/api/files/*`, `/api/runs/{id}/files[/{name}]`, `/preview/files/{id}`    |
  | MCP tools           | `list_documents`, `read_document`, `import_package_document`, `validate_package_document` | `list_files`, `read_file`, `import_package_file`, `validate_package_file` |
  | Run event / run log | `document.published`, `event: "document"`                                                 | `file.published`, `event: "file"`                                         |
  | Run DTO             | `document_counts`                                                                         | `file_counts`                                                             |
  | Inline launch body  | `context_documents`                                                                       | `context_files`                                                           |
  | Upload header       | `X-Document-Name`                                                                         | `X-File-Name`                                                             |
  | Permission resource | `documents:read`, `documents:delete`                                                      | `files:read`, `files:delete`                                              |
  | Problem code        | `document_count_exceeded`                                                                 | `file_count_exceeded`                                                     |
  | Tables              | `documents`, `document_links`                                                             | `files`, `file_links`                                                     |
  | French UI           | « Documents »                                                                             | « Fichiers »                                                              |

  `appfile://` rather than `file://`: the latter already means the local
  filesystem and is what MCP uses for local resources, so an opaque platform id
  under it is ambiguous to the model and to every MCP client.

  **The rename now reaches the physical layer too**, and none of it has an
  alias. The row-id prefix is `file_` (`prefixedId("file")`, validated by
  `FILE_ID_RE`); the durable storage bucket and its `storage_key` prefix are
  `files`, and the run-workspace input prefix is `{runId}/files/`; the
  `storage_deletion_jobs.reason` labels are `file_deleted` / `file_expired`;
  and the four file-limit environment variables are renamed:

  | Before                     | After                       |
  | -------------------------- | --------------------------- |
  | `DOCUMENT_MAX_FILE_BYTES`  | `FILE_MAX_BYTES`            |
  | `DOCUMENT_RETENTION_DAYS`  | `FILE_RETENTION_DAYS`       |
  | `RUN_MAX_DOCUMENTS`        | `RUN_MAX_FILES`             |
  | `WORKSPACE_MAX_DOCS_BYTES` | `WORKSPACE_MAX_FILES_BYTES` |

  An `.env` still carrying an old variable name is not read — the schema
  ignores it and the limit silently reverts to its default — so grep for the
  left column above. See `docs/ENV.md` and `docs/architecture/FILES.md`.

  **What is gone, and what a caller gets instead:**

  1. **The nine `/documents` route registrations — six on the file routes,
     three run-scoped — are gone. They 404.** Eight operations drop out of the
     OpenAPI document, along with both alias generators in the spec (the second
     of which was a divergent copy that hand-rolled an unanchored
     `replace("/files", "/documents")`). The baseline is regenerated in the same
     commit, as `detect:breaking` requires, so CI reports no change and this
     list is the record. Use `/api/files/*` and
     `/api/runs/{id}/files[/{name}]`.
  2. **`X-Document-Name` is gone, and `X-File-Name` is now properly
     `required`** — the alias was the only reason it was not. An upload
     arriving without `X-File-Name` is an explicit `400`.
  3. **`context_documents` on both inline-run bodies, and the `dataschema`
     CloudEvents attribute on the run-events ingestion route, are `400`s.**
     Each of those bodies is `.strict()`, so the retired field is refused by
     name rather than stripped. The `run_and_wait` TOOL ARGUMENT of the same
     name used to be canonicalized to `context_files` by the shared launch
     client; it is now refused by name there too. Refused rather than merely
     unread, because that client builds the launch body from an allowlist —
     an argument nobody names is invisible, and the run would start with
     nothing mounted while every layer reported success.
  4. **`document.published` is no longer accepted as a runtime-tool event**, at
     either acceptor — and the two are safe for different reasons. Inside the
     container the reason is structural: the only producer of that name is
     core's own `filePublishedEvent`, bundled into the SAME artifact as the
     trust-boundary acceptor `reEmitRuntimeToolEvents`, so there is no version
     boundary between them and the retired name can only arrive forged, which
     is what the acceptor's drop is for. The platform-side sink
     (`persistRunEvent`) is a DIFFERENT artifact reached over HTTP, so that
     argument does not reach it; what does is the image-tag rule above — plus
     the fact that the event's own precondition went with it, since a
     pre-`#1177` container emits `document.published` only after a SUCCESSFUL
     `POST …/documents`, and that route now 404s.
  5. **`workspace/documents/` and the `documents` twin key in the run-input
     manifest are gone from both sides.** `runtime-pi/provision.ts` no longer
     probes `/documents` after a `404` on `/files` (that `404` is the ordinary
     "this run carries no input files" case, so the fallback cost a second
     signed round-trip on the common boot path to reach a route no platform
     serves), no longer reads `manifest.files ?? manifest.documents`, and no
     longer symlinks `documents -> files` in the workspace. The manifest's
     `documents` key was in `required`, which made the deprecated spelling
     contractually mandatory. A pre-rename manifest object now fails loudly at
     both consumers: the serve path `500`s and the container dies with
     `Failed to fetch files manifest` rather than starting with an empty
     workspace, and the deletion path throws and dead-letters.
  6. **`document://` no longer parses.** It survived to read historical rows,
     but every URI ever written under it addresses a `doc_` id and `FILE_ID_RE`
     stopped accepting those, so the only form the accept path could still have
     matched was `document://file_…` — which no build has ever emitted. A
     `document://` value now fails at `parseFileUri` instead of one line later
     on the id, in the same `400`.
  7. **`documents:read` / `documents:delete` are refused, and this is the one
     retirement with a real caller behind it.** The read-time alias layer is
     gone: `LEGACY_PERMISSION_RESOURCE_ALIASES`, `canonicalPermission`,
     `canonicalPermissions`, `acceptedPermissionSpellings`, the second-chance
     branch inside `makePermissionGuard` (which backs all three permission
     guards), and the scope canonicalizers across the OIDC module. The alias
     itself never shipped — but `documents:*` **is** the spelling every
     released Appstrate advertised, so a third-party OAuth client integrated
     against `v1.0.0-beta.51` holds it in config and now gets `invalid_scope`
     at `/oauth2/authorize` instead of being silently rewritten. That is a
     deliberate trade: for a beta with no production data, a loud refusal is
     the right failure and a silently under-granted scope is not. The live
     windows are bounded by their own TTLs — an access token expires in 15
     minutes, a pending authorization code in 10 — and an
     `OIDC_INSTANCE_CLIENTS` value still naming `documents:read` fails boot
     with a message that prints the offending string rather than rewriting it.
     What the caller SENDS is refused; what is already STORED is migrated —
     `0046` rewrites every persisted spelling, so no existing credential is
     silently narrowed. See "Migrations" below.

     The API-key write path now refuses on the same principle. `POST
/api/api-keys` with a scope that is not grantable at all — an unknown
     string, a retired spelling like `documents:read`, or a session-only
     permission — is a `400` naming the offender, where it previously filtered
     the value out and answered `201` with a key that then 403'd on
     everything. A scope that is valid but above the creator's own role is
     still narrowed silently: that is a real rule ("you cannot delegate more
     than you hold"), not a swallowed typo, and the scopes-omitted default
     branch relies on it.

     Three tests were passing only because of the alias, which justifies the
     removal on its own: `enduser-token-auth` minted tokens carrying
     `documents:read` and asserted `/api/files/*` answered `200`. #1193 renamed
     the routes and left the scopes on the old spelling; the alias hid the gap.

  **Nothing reads an old spelling any more.** The rename shipped with a read
  alias on every wire-visible spelling. The last five were kept on the
  strongest ground available — a value a RELEASED build wrote into a place the
  current build still reads, or a vocabulary a protocol had told a client was
  stable — and they are gone too, because no such value and no such client
  exists:

  - `run_logs` rows tagged `event: "document"` are no longer rendered
    (`PUBLISHED_FILE_LOG_EVENTS` is now just `["file"]`). Such a row would show
    without its attachment — an absence, not an error.
  - The `documents` key of a persisted `run_and_wait` result, and items keyed
    `document_id`, are no longer read. Only `files` / `id` / `file_id` are.
  - `publish_document` in `manifest.runtime_tools` is no longer canonicalized.
    Author input naming it is REFUSED; a stored manifest has it DROPPED and the
    drop REPORTED to the caller — never silently reinterpreted as `publish_file`.
  - The four retired MCP tool names are no longer registered. A client holding
    a cached tool list gets `-32602 Unknown tool` and re-lists; that was the one
    alias with a live protocol argument behind it (`tools.listChanged: false`),
    and the cost is transient where the second dispatch path was permanent.
  - `context_documents` as a `run_and_wait` tool argument is REFUSED BY NAME.
    That distinction is the whole point: the launch body is built from an
    allowlist, so merely not reading it would make it invisible — the run would
    start with nothing mounted and every layer would report success.

  Two more went with them: the `setDocumentStorageLimit` platform-services
  alias (`@appstrate/cloud` now binds `setFileStorageLimit`; see the ship order
  below) and every retired run-detail tab hash. The `result.text` /
  `result.text_truncated` fields of the removed `report` tool left the run
  resource at the same time.

  **Ship order, and it is not optional.** `@appstrate/cloud` binds the storage
  capability off the LIVE services object the platform injects, not off its
  pinned types, so a rename does not reach its read — it `TypeError`s its next
  boot. Publish `@appstrate/core` 8.0.0 → release `cloud` (already moved to
  `setFileStorageLimit` and `>=8.0.0`) → deploy this platform build. The
  published `7.0.0` exposes only the old name, so cloud's range had to move
  with it.

  **What a consumer has to do:**

  1. **The run resource field `document_counts` is now `file_counts`, and
     `primary_document_id` is gone.** There is NO response-side alias for
     either: an out-of-tree API consumer still reading them gets `undefined`,
     silently, with a `200`. This repo has already broken a consumer exactly
     this way (`github-action` sending a removed field), so it is spelled out
     rather than left to the diff. Read `file_counts.{input,output}`; for "which
     file to show", see the derived rule under Removed.
  2. **Five RFC 9457 problem codes are renamed, and NONE of them has a read
     alias.** The code is a string a client branches on; an unrecognised value
     falls to whatever the client's default arm does, silently.

     | Before                    | After                 | Raised by                                                                                       |
     | ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
     | `document_count_exceeded` | `file_count_exceeded` | `413`, `RUN_MAX_FILES` over-cap (`@appstrate/core/api-errors`)                                  |
     | `document_in_use`         | `file_in_use`         | `409`, `DELETE /api/files/{id}` on a file a live run still links (`services/files.ts`)          |
     | `document_unavailable`    | `file_unavailable`    | `409`, an input file deleted between resolve and run creation (`services/state/runs.ts`)        |
     | `duplicate_document_name` | `duplicate_file_name` | `400`, colliding workspace names in a run's input manifest (`services/run-file-naming.ts`)      |
     | `document_uri_in_prompt`  | `file_uri_in_prompt`  | field-level code inside the `400 validation_failed` on an inline run (`services/inline-run.ts`) |

     The limits and the statuses are unchanged; only the strings moved.

  3. **`publish_document` is now `publish_file` and no longer accepts
     `presentation`.** The retired id is not aliased: author input naming it is
     refused, and a stored manifest has it DROPPED with the drop REPORTED to
     the caller. That report is the part that matters —
     `dropRetiredRuntimeTools()` removes ids it does not recognise, so a silent
     drop would strip the tool from an agent that had selected it with nothing
     in any log. A caller that still sends `presentation` has it ignored, not
     rejected.
  4. **The four MCP tools are renamed, and the old names are gone.**
     `list_documents`, `read_document`, `import_package_document` and
     `validate_package_document` are no longer registered, hidden or otherwise,
     and the `document_uri` argument is no longer renamed on the way in. The
     server advertises `tools: { listChanged: false }`, so a client that listed
     before the upgrade and calls an old name after it gets `-32602 Unknown
tool` and re-lists. That is the one alias here with a live protocol
     argument behind it; the cost of dropping it is transient, where a second
     dispatch path for four capabilities was permanent.

     One MCP break is NOT covered by any alias, and it is client-facing: a
     dynamically-registering client whose published Client ID Metadata Document
     still declares `documents:read` / `documents:write` now fails registration
     with `invalid_scope`. `@better-auth/cimd` lists `scope` in
     `ALLOWED_METADATA_FIELDS` and feeds it into
     `createOAuthClientEndpoint(..., { isRegister: true })`, which validates
     every requested scope against the server's set and throws on anything
     outside it. Nothing is silently mis-granted — registration is refused
     outright — but the client's own metadata has to be updated to the `files:`
     spelling. Tell any partner registering through CIMD before you deploy.

  5. **The four OpenTelemetry metric series are renamed:
     `appstrate.documents.created`, `.deleted`, `.storage_limit_rejections` and
     `.partial_publications` are now `appstrate.files.*`.** Nothing errors —
     dashboards, alerts and recording rules built on the old series simply go to
     zero and stay there. Repoint them, and check any alert whose condition is
     "below threshold": those fire, and the ones that are "above threshold" go
     quiet without ever telling you why.
  6. **`@appstrate/core`: the `./document-uri` subpath is now `./file-uri`**,
     with `DOCUMENT_URI_PREFIX` → `FILE_URI_PREFIX`, `isDocumentUri` →
     `isFileUri`, `parseDocumentUri` → `parseFileUri`, `documentUri()` →
     `fileUri()`, `extractDocumentIds[FromText]` → `extractFileIds[FromText]`,
     plus renames on `./permissions`, `./telemetry`, `./api-errors`, `./module`
     and `./run-and-wait-client`. **Core is NOT published from this branch** —
     but this build cannot ship before it is. `cloud` binds
     `services.setFileStorageLimit` off the LIVE services object this platform
     injects at boot, and the deprecated `setDocumentStorageLimit` alias that
     used to cover that seam is gone. A type-level pin never protected it: a
     property read at boot does not typecheck. Ship order is core `8.0.0` on
     npm → `cloud` (already moved, and its range raised to `>=8.0.0` because
     the published `7.0.0` exposes only the old name) → this platform build.
     Deploying the platform first `TypeError`s cloud at boot.
     `connect-helper` reads none of this surface. See
     `packages/core/CHANGELOG.md`.

  **OPERATOR ACTIONS, and SQL cannot perform them.** Migration
  `0044_finish_file_rename` carries the data half — it rewrites every
  `files.storage_key` from `documents/…` to `files/…`, the outbox's copy of the
  bucket name, the run-workspace keys the outbox holds, and the two deletion
  reasons. **It moves no bytes.** Until the objects follow, a download `404`s on
  a file that physically exists. In the same window:

  - **drain in-flight runs BEFORE the platform restarts**, and do not launch
    new ones until the window closes. A container the previous platform process
    started is not stopped by the upgrade and is not reaped at boot while it is
    still heartbeating, so it survives into the new platform and its
    `POST …/documents` 404s — losing the deliverable while the run finalizes
    green. This is the same drain the run-workspace rename below needs, so one
    drain covers both;
  - copy the `documents` bucket onto `files` and drop the old one
    (`aws s3 sync s3://documents s3://files`, or `mc mirror`); on filesystem
    storage (tier ≤ 2) it is a directory rename under
    `./data/storage/`, `documents` → `files`;
  - rewrite the second key segment of every `{runId}/documents/<name>`
    run-workspace object to `{runId}/files/<name>`. **In-flight runs do not
    survive that rename — drain them first.**

  **A database holding `doc_` ids should be reset, not migrated.** Existing
  `files.id` values are deliberately NOT re-minted, and `FILE_ID_RE` now
  accepts only `file_`, so those rows are unaddressable: the id fails
  validation before any query reaches them. Re-minting is not a two-table
  `UPDATE` — the id is quoted inside `runs.input`, `runs.result`, `run_logs`,
  chat payloads and append-only `audit_events.after` — and a partial rewrite
  would silently break every rerun, which is worse than none.

  **Stored permission scopes are the opposite case — they ARE migrated.** The
  verdict above does not extend to them: `0046_legacy_permission_scope_strings`
  rewrites every persisted `documents:*` spelling to `files:*` at migration
  time, across all seven columns that carry the vocabulary — the five `text[]`
  ones (`api_keys.scopes`, `oauth_clients.scopes`, `oauth_consents.scopes`,
  `oauth_refresh_tokens.scopes`, `oauth_access_tokens.scopes`) and the two
  space-delimited `text` ones (`cli_refresh_tokens.scope`, `device_codes.scope`).
  A credential issued under the old spelling therefore keeps exactly the grant
  it was issued with. That rewrite is load-bearing, not cosmetic: with the read
  alias gone, `resolveApiKeyPermissions` intersects a key's stored scope set
  with its creator's role permissions and DROPS what it does not recognise, so
  an un-migrated `documents:read` would leave the key authenticating and
  silently granting less — the same silent under-grant on every CLI refresh
  rotation (`narrowScopeToClient`) and every live bearer token
  (`scopesToPermissions`).

  **The read path stays canonical-only, by design.** Nothing translates
  `documents:*` at read time any more, and nothing should: an OAuth client that
  still SENDS the old spelling is refused outright with `invalid_scope` at
  `/oauth2/authorize`. That is the deliberate trade — a loud refusal a caller
  can see and fix, rather than a rewrite that hides the drift. The migration
  fixes what is already STORED; it does not make the old spelling acceptable on
  the wire.

  **Migrations.** `0042` drops the `presentation` column with its partial unique
  index and CHECK. `0043` is a pure `ALTER … RENAME` of the tables, columns,
  enum type, indexes and constraints — catalog-only, no table rewrite, no data
  movement, no window where a constraint is absent. The previous `0044` and
  `0045`, which rewrote persisted `documents:*` scope strings, are **deleted**
  along with their journal entries and snapshots, and their numbers reused:
  `0044_finish_file_rename` is the physical-layer migration described above,
  and `0045_drop_integration_refresh_failure_timestamp` drops one more
  write-only column. Their scope rewrite is not lost — it lands at
  `0046_legacy_permission_scope_strings`, which carries both column shapes in
  one file. All of them are idempotent and converge from a partially applied
  state.

  A database that already applied the OLD `0044`/`0045` carries a
  `drizzle.__drizzle_migrations` watermark that now matches no journal entry.
  Drizzle compares timestamps rather than tags, so nothing errors and the new
  `0044`, `0045` and `0046` all still run; the bookkeeping table simply records
  two migrations this folder can no longer explain, and the forward-only scope
  rewrite they performed produced exactly the strings `0046` produces, so it
  finds nothing left to do.

  **`0043` is irreversible, and the rollback is a hard outage, not a degraded
  mode.** There is no down migration in the repo and `0043` creates no
  compatibility view. Once boot has applied it, the previous release's code
  queries `documents`, `document_links` and `organizations.documents_bytes_*` —
  none of which exist under those names any more. **Take a database snapshot
  immediately before the deploy**; it is the only fast way back. To reverse by
  hand:

  ```sql
  ALTER TABLE "files" RENAME TO "documents";
  ALTER TABLE "file_links" RENAME TO "document_links";
  ALTER TABLE "document_links" RENAME COLUMN "file_id" TO "document_id";
  ALTER TABLE "organizations" RENAME COLUMN "files_bytes_used" TO "documents_bytes_used";
  ALTER TABLE "organizations" RENAME COLUMN "files_bytes_limit" TO "documents_bytes_limit";
  ALTER TYPE "public"."file_purpose" RENAME TO "document_purpose";
  ```

  Constraint and index names are cosmetic to the old code and can be left
  alone. `0042` is not reversible at all — the `presentation` column and its
  data are dropped, and only the snapshot brings them back. Neither is the
  physical `0044`: the object move it requires is yours to undo too.

  **Deploy order is now enforced rather than documented — for the pairings the
  check can see.** Rolling the platform and the runtime images out of step used
  to be a live hazard — a new image against an old platform posted every
  `publish_file` to a `/files` route that did not exist, so the run finished
  with no deliverable and nothing in the platform log said why. The version
  contract below refuses to boot on that pairing, so for a configured mismatch
  the failure moved from "silent, at run time" to "loud, at start". It stays
  silent wherever that check is blind — its own carve-outs (`image-ref.ts`),
  and above all a container already running when the platform restarts, which
  no boot-time check can see — which is why the drain step above is part of
  this upgrade. Ship the platform and both images from one version, which is what
  all four shipped compose paths already do.

- **BREAKING: the runtime images must now agree with the PLATFORM's version,
  not just with each other — and a disagreement fails boot.** #1201 turned
  `PI_IMAGE` / `SIDECAR_IMAGE` into a version contract, but the check compared
  the pair to itself: a platform at version X with both runtime images at X−1
  booted happily and then failed runs with the opaque upstream error the
  contract exists to prevent. That is exactly the skew half a dozen
  compatibility shims in this codebase were justified by, including the
  `document` aliases removed above.

  The comparison now includes `APP_VERSION`, which already existed — baked by
  the Dockerfile, fed by `release.yml` as the git ref, surfaced on `/health`
  and in the SPA footer. No new variable, no file read at boot.

  The two halves are deliberately not symmetric. `PI_IMAGE` and `SIDECAR_IMAGE`
  are always compared to each other literally, as they were under the pair
  rule: every compose file sets both from one `${APPSTRATE_VERSION}`, so any
  difference between them is a half-done edit whatever tag family it is in. The
  platform joins the comparison only when **all three values are release
  versions**. `APP_VERSION` is a git ref name, so it can equal an image tag only
  in the one family (`{{version}}`) the two namespaces share; `release.yml`
  publishes three others for the very same image (`latest` — documented as the
  compat fallback for consumers that skip the CLI —, `{{major}}.{{minor}}`, and
  `sha-<sha>`). Comparing against those, or against a non-release build stamp
  (`dev`, the Dockerfile default and source-run fallback; `health-container-e2e`,
  what the container health job builds with against `:local` images), does not
  detect skew — it makes the rule unsatisfiable, since no legitimately-built
  image tag can ever equal such a value and the only escape would be pinning
  digests. Any of those drops the platform out and the rule degrades to the pair
  rule, which is what keeps dev boxes, preview deployments, that CI job and
  `:latest` consumers booting. A digest-pinned ref on either image is exempt
  outright: a digest identifies an image by content, so there is no version to
  compare, and an operator pinning digests has taken explicit control of image
  identity.

  **What this deliberately does not catch.** Both runtime refs floating on
  `:latest` under a released platform is accepted. That is not a gap left open
  by choice of predicate — tag comparison cannot see it at all: `APP_VERSION` is
  baked at build time and reads identically whether the platform image was
  pulled by its version tag or by `:latest`, so `{platform 1.0.0-beta.52, pi
latest, sidecar latest}` is byte-for-byte the same input as the supported
  all-`:latest` deployment. Only something reading the images actually present
  on the host can separate them. `runtime-image-pair.ts` is untouched and stays
  complementary for exactly that reason: it compares OCI revision labels after
  the pre-pull — the same-tag-two-builds case — and it warns rather than
  refusing. Promoting that guard to a refusal, not re-tightening the tag rule,
  is the way to close this.

- **Long Anthropic cache retention is refused on the model record, not by
  convention — and `cacheRetention` is no longer forwarded from the
  container.** Both doorways to 1-hour cache creation were open:
  `FORWARDED_OPTION_KEYS` carried `cacheRetention` and `projectRequestOptions`
  relayed it verbatim from the container's own request body, and pi-ai also
  resolves the option from `process.env` at request time, so agent code inside
  the container could set `PI_CACHE_RETENTION` directly. Either way Anthropic
  bills those cache-creation tokens at 2× the input rate while
  `computeTokenCost` has no term for them, so the platform's authoritative
  price came out low with nothing to notice.

  Both model builders now set `compat.supportsLongCacheRetention: false`, which
  pi-ai honours on every API shape it drives (`anthropic-messages`,
  `openai-responses`, `openai-completions`); the sidecar's `compat` is no
  longer conditional on adaptive reasoning, with the existing
  `forceAdaptiveThinking` folded in. `cacheRetention` also leaves the forwarded
  option set on boundary-hygiene grounds — `"none"` steers caching too, and the
  sidecar has no business honouring a container-chosen knob whose semantics
  differ per vendor. It is logged as discarded by the existing set difference.
  Caching itself is unaffected; only the 1-hour TTL is.

- **The run page is four fixed tabs: Outcome, Fichiers, Exécution,
  Configuration.** The previous set (Résultat / Deliverable / logs / memory /
  files / info) grew by accretion, mixed three unrelated questions across five
  panes, and made two of them appear and disappear per run — so the strip had a
  different shape depending on which run you opened. Now every pane renders for
  every run: **Outcome** is what the run produced (the `output` tool's value,
  the files it produced, the memory it wrote), **Fichiers** is every file
  attached to the run — imported and produced, **Exécution** is how it ran
  (logs, execution details, usage, per-turn breakdown, input payload,
  identifiers), **Configuration** is how it was set up (agent, version, trigger,
  connections).

  « Résultat » is now « Output »: the section is literally what the `output`
  tool emitted, not a verdict on the run. The top bar states whether a run is an
  inline run or an agent run.

  **The retired tab hashes no longer resolve.** `#deliverable`, `#result`,
  `#memory`, `#documents`, `#logs` and `#info` were each mapped onto the pane
  that absorbed them and rewritten in the address bar; the whole table, its
  mapping function and the rewrite effect are gone. A bookmark, a back-history
  entry or a link pasted into an old chat message now opens the default pane,
  silently — the page cannot tell that anchor apart from any other it does not
  know. Accepted so these anchors have one vocabulary rather than two.

- **BREAKING: the schedule launch bodies are validated too — it was the fourth
  launch surface, and the one where a bad value is permanent.** #1189 made every
  agent-launch body `.strict()` and value-checked, and covered three surfaces.
  `POST /api/agents/{scope}/{name}/schedules` and `PUT /api/schedules/{id}`
  freeze exactly these fields onto `package_schedules` and replay them at every
  fire, so a defect there is not one mis-executed run, it is a wrong run forever
  with a `201` as the only receipt. Three gaps, all closed against the run
  route's existing rules: `connection_overrides` values lacked `.min(1)`, and
  the pin is applied with a truthy check, so an empty id was skipped without a
  trace and every fire fell through to actor-fallback or died with
  `412 must_choose_connection`; neither schema was `.strict()`, so an unknown
  field was silently stripped; and `dependency_overrides` values were never
  checked, because a schedule resolves through `resolveEffectiveInput` +
  `validateInput` and never calls the parser the agent route gets that gate from
  — so an unresolvable value froze onto the row and failed at every fire instead
  of at the write. `minLength: 1` on `connection_overrides` is now documented at
  the three run surfaces as well: the Zod has always enforced it, and the spec
  said plain `{ "type": "string" }`.

  **Why this is BREAKING and not a fix: `.strict()` makes read-modify-write a
  `400`.** The spec's `Schedule` response component has 26 properties;
  `updateScheduleSchema` accepts 11 of them (`name`, `cron_expression`,
  `timezone`, `input`, `enabled`, the four `*_override` fields,
  `connection_overrides`, `dependency_overrides` — plus `actor`, which is not a
  response field). The other 15 are now refused BY NAME: `id`, `packageId`,
  `userId`, `endUserId`, `orgId`, `applicationId`, `last_run_at`, `next_run_at`,
  `createdAt`, `updatedAt`, `actor_name`, `actor_type`, `running_runs`,
  `unread_count`, `last_run_number`. A third-party client that does the obvious
  thing — `GET /api/schedules/{id}`, flip `enabled`, `PUT` the object back —
  previously had those keys stripped and got a `200`; it now gets a `400` on
  `id`. In-repo callers are unaffected: `useUpdateSchedule`
  (`apps/web/src/hooks/use-schedules.ts`) destructures `id` into the path and
  sends only the remaining fields as the body. Send only the fields you mean to
  change.

### Removed

- **Three columns that were written and never read**, with their writers
  (migrations `0044` and `0045`). The `last_refresh_failure_at` columns on
  `model_provider_credentials` and on `integration_connections` were stamped
  beside `refresh_failure_count` on
  every transient refresh failure; it is the COUNTER that drives the
  `needs_reconnection` escalation, and the timestamp was never a term in that
  predicate, appeared in no DTO and in no query, and was read only by the
  integration tests asserting its own write.
  `model_provider_pairings.consumed_from_ip` was written by `consumePairing`
  and read by nothing — its "for audit" justification never held, because
  `cleanupExpiredPairings` DELETEs the row an hour past expiry and the audit
  entry written at redeem time omits the IP, so the trail it was meant to leave
  was erased and the record that survives never carried it. All three had been
  kept on the premise that they held real data already collected. Forward-only
  and cheaply so: none was an input to any decision.

- **`presentation: "primary"`, and everything behind it.** The
  `publish_document` argument, the `documents.presentation` column, its partial
  unique index `uq_documents_run_primary`, its CHECK constraint, the
  `X-Document-Presentation` ingestion header, and the derived run-DTO field
  `primary_document_id` are all gone (migration `0042`).

  It conflated two different questions — how important a file is, and whether
  the UI opens it — and forced at most one per run, which made the producing
  agent arbitrate a presentation decision that was never its call: an agent that
  wrote three peer files had to crown one or leave the run looking empty.

  What replaced it is derived from what the run produced, computed client-side
  and applied identically on the run page and in the chat: **0 produced files →
  nothing is featured; exactly 1 → it is shown by default; N → all listed, none
  opened, the user picks.** Only files with `purpose = 'agent_output'` whose own
  `run_id` is this run count — never an input, and never a file chained in from
  an earlier run via `appfile://` (which is listed in the run's container while
  still carrying `purpose: 'agent_output'`, because an earlier run produced it).
  Nothing server-side stores or computes it, which is why the dropped column
  needed no replacement pointer: there is no second place left to go stale when
  a file is deleted, expires, or is detached. In the chat the rule additionally
  waits for a settled run, because a run publishing three files emits them one
  at a time and a mid-stream count of 1 is not the final count.

  A `presentation` argument sent by a stale caller is ignored rather than
  rejected — losing a real deliverable over a dead argument would be the worse
  failure — and a runtime image older than the platform may still send
  `X-Document-Presentation`, which the ingestion route reads as nothing and
  never answers `400` to.

### Fixed

- **`appstrate run` validates the resolved input against the agent's schema
  again.** The `config` → `input` collapse (#1179) deleted the CLI's validation
  and replaced it with nothing: at `v1.0.0-beta.51` the site read
  `validateConfig(config, configSchema)` and exited with a field summary, and
  afterwards it was a bare `resolveLocalInput(...)` with no validator at all.
  The docstring claimed "the bundle's own `required` check sees the truth";
  there is no such check — the runtime reads `input.schema.required` only to
  print the word "required" beside the field. So a required field answered
  nowhere reached the model as an empty render, and a wrong-typed or
  out-of-enum value launched the container and burned tokens instead of failing
  fast, which is exactly the local/remote parity #1179 set out to deliver.
  `validateLocalInput` calls the same `validateAgainstSchema` the server's
  `validateInput` wraps, so the same (input, schema) pair reaches the same
  verdict on both sides. An agent declaring no `input.schema` accepts anything,
  so the gate is a no-op there rather than a rejection.

- **A `charset` parameter no longer routes a binary download through the text
  decoder.** `isTextLikeMimeType` tested for `;charset=` BEFORE looking at the
  media type, so an OOXML spreadsheet type answered with a `charset=utf-8`
  parameter appended took the lossy `fatal:false` text decode — the OOXML
  corruption class this resolver was rewritten to prevent.
  The docblock defended the order with "an OOXML container carries no charset",
  which is an assumption about upstream servers rather than an invariant: one
  that blanket-appends a charset defeats it. The charset rule now applies only
  when the base media type is ambiguous. A third local MIME parser in the same
  file goes with it: it did not lowercase, and its output fed an exact-literal
  comparison against `application/octet-stream`, so an upstream answering
  `Application/Octet-Stream` was treated as unambiguous — magic-byte sniffing
  was skipped and the stored file kept the mixed-case string as its `mime`.

- **A graceful shutdown is no longer pinned to its full 10s cap by a job that
  is only counting down.** `LocalQueue.shutdown()` waits for `activeJobs` to
  reach zero, and a job sleeping between retry attempts counted as active — its
  `run()` awaits its own retry timer. So a single permanently-failing job (a
  ledger replay whose org was deleted, say) held the count above zero for its
  entire retry schedule and delayed every restart by the full cap. `shutdown()`
  now abandons jobs with nothing in flight, and the retry path refuses to
  schedule or resume once shutting down — abandoning is this queue's documented
  semantics, since in-memory jobs do not survive the process and a retry that
  has not started has nothing to lose. Retry timers are `unref`'d, matching the
  existing rationale for the drain and cron intervals. Found by diagnosing a
  test flake rather than by raising its deadline: no test deadline changed.

- **CLI output redirected to a file no longer contains terminal escape codes.**
  `@clack` gates only an extra newline on CI and writes `cursor.up` /
  `erase.down` unconditionally, so `appstrate install > install.log` wrote
  control sequences into the file. The spinner now branches on `isTTY`, like
  the CLI's own colour policy, and emits plain lines otherwise. In the same
  pass, five more command modules (`doctor`, `models`, `internal`, `logout`,
  `self-update`) take the `CommandIO` sink instead of writing to the process
  globals, every direct `clack.*` call outside `lib/ui.ts` is gone, and
  `no-console` is an ESLint rule over `apps/*/src` and `packages/*/src` rather
  than a convention enforced by review — it was enabled nowhere, and one real
  offender had survived in `lib/self-update.ts`.

- **Sixteen endpoints' documented request bodies did not match the Zod that
  validates them.** The OpenAPI gate locked ~42 documented request bodies to the Zod
  that validates them and checked none of the rest, so a launch surface could
  drift from its published body with every gate green. `verify-openapi.ts` §4b
  now fails when a documented request body is neither registered against its
  Zod nor exempt with a stated reason (16 are, each with one), mirroring what
  §7b already did for responses. The drift it surfaced: the package `PUT`
  bodies required `manifest` + `content` although the handler explicitly
  supports content-only and manifest-only saves; `POST /api/packages/agents`
  required `content` where its skill and integration siblings do not; six
  documented fields were missing their length constraints; fields carrying a
  `default:` were marked `required` (Zod's default output view marks a
  `.default()` field required, which is wrong for a request body — the
  conversion now uses `io: "input"`); and two module routes (`webhooks` rotate,
  `smtp-config/test`) had no spec entry at all. The generated document is
  otherwise byte-identical: the header-block and `{values, locked_fields}`
  de-duplication in the same pass changed no wire shape.

- **One Ajv instance, so the per-run validator cache behaves.** `apps/api` stood
  up a second instance with its own `compileCached`, and the two had diverged:
  core wraps `compile` in `try/finally` with `removeSchema` and evicts FIFO,
  while the `apps/api` copy did neither — so its registry grew unbounded in a
  long-lived process, and a schema carrying `$id` compiled twice from two
  objects would throw. This is the per-run hot path. Both behaviours are now
  pinned by tests from either caller.

- **A file attached in the chat now becomes an input of the inline run it
  triggers.** It did not, for two independent reasons that had to be fixed
  together: the chat system prompt never told the model that a top-level
  `context_files` argument existed, so it had no way to pass the attachment on;
  and the shared `run_and_wait` launch client
  (`packages/core/src/run-and-wait-client.ts`) read only the canonical
  `context_files` name and dropped the legacy `context_documents` spelling
  before the HTTP call — an allowlist builds the launch body, so a model that
  reached for the argument under its pre-#1177 name, from an earlier turn or a
  stale tool listing, watched it disappear with no `400` from anywhere. The run
  started anyway, with no error and no file — the agent simply worked without
  the attachment the user had just given it. The client now canonicalizes the
  retired argument name to `context_files`; the HTTP route itself no longer
  knows the old spelling at all, and answers `400` to it.

### Added

- **The `check` chain now fails on dead exports** (`bun run verify:dead-code`,
  backed by [knip](https://knip.dev) and `knip.config.ts`). `no-unused-vars`
  only sees locals — an exported symbol is "used" by construction — so nothing
  in the gate could answer "does this exported symbol still have a reader".
  That blind spot is what let the dead weight removed in the previous audit
  accumulate for months. The same pass also reports dead files and unused
  dependencies. Entries and ignores in `knip.config.ts` each carry a
  justification: an entry says _what reaches the file_, an ignore says _why
  knip is structurally blind_.

  Published packages are deliberately out of scope for public-export death:
  `@appstrate/core`, `@appstrate/afps-runtime` and the `@appstrate/module-*`
  packages are consumed out of tree, so "no in-repo reader" is not evidence.
  That exemption is obtained by hand, not inherited: knip derives no entry
  from a package manifest — it reads neither `exports` nor `bin`, `main` or
  `module` — and declaring an `entry` array for a workspace replaces even its
  filename defaults. So each published workspace must re-declare every target
  of its export map in `knip.config.ts`, or its whole public surface reads as
  dead. Letting that drift is what produced a ~161-finding false red.

### Removed

- **Dead declarations the new gate surfaced.** ~500 superfluous `export`
  keywords (types and values used only inside their own file), plus a handful
  of declarations that had no reader at all once the re-export was dropped —
  `createTestSession`, `parseSSEStream`, `patchProcessExit`, `seedOrgProxy`,
  `connectLoginBlock`, `getSystemPackagesByType`, `hasExternalDb`, `hasS3`,
  `itRequiresRedis`/`Docker`/`S3`/`Postgres`. No runtime behaviour changes.

- **Dependencies no source file imports.** `apps/web` declared 14
  `@radix-ui/*` packages plus `ajv`, `ajv-formats`, `class-variance-authority`,
  `clsx`, `cmdk` and `tailwind-merge` that belong to (and are declared by)
  `@appstrate/ui`; `apps/api` declared `ajv-formats`, `semver` and the
  deprecated `@types/ioredis` stub; the root manifest duplicated `ajv`,
  `@types/json-schema` and `@types/semver` already declared by
  `@appstrate/core`; `packages/db` declared `@better-auth/drizzle-adapter`
  and `@appstrate/runner-pi` declared `ajv`. Only `@appstrate/runner-pi` is
  published, and it never imported `ajv`, so installs get one fewer transitive
  package.

- **Every `config` wire field, with no alias and no deprecation window.**
  `config` on the run / inline-run / remote-run bodies; `config` and
  `config_override` on the Run resource; `config_override` on schedules;
  `config` on the installed-package listing and on `GET .../run-config`;
  `--config` on the CLI; and the error code `invalid_config`, replaced by
  `invalid_input` and joined by `locked_input_field` and
  `locked_required_field_empty`. `PUT /api/agents/{scope}/{name}/config` is now
  `PUT /api/agents/{scope}/{name}/input-settings`.

  `detect:breaking` reports "no changes" for all of it because the OpenAPI
  baseline was regenerated in the same commit. CI will not flag any of the
  above — this list is the record.

- **Twelve unscoped package endpoints are gone.** `GET`, `PUT` and `DELETE` on
  each of `/api/packages/agents/{id}`, `/api/packages/skills/{id}`,
  `/api/packages/integrations/{id}` and `/api/packages/mcp-servers/{id}`. Use
  the scoped forms instead — `/api/packages/agents/{scope}/{name}`, and so on
  for the other three types.

  Every package identifier Appstrate produces is `@scope/name`
  (`buildPackageId()` returns that unconditionally, and `0000_init.sql` is
  squashed), so no unscoped id has ever existed to address. But "unreachable"
  is too strong and is why this is a release note rather than only a source
  comment: the routes took a single-segment path parameter, so a client that
  percent-encoded a scoped id — `encodeURIComponent("@scope/name")` →
  `%40scope%2Fname` — got a working request. No in-repo or first-party consumer
  did this (`apps/cli`, `apps/web`, `e2e`, `runtime-pi`, `docs`, the GitHub
  Action, `cloud` and `connect-helper` all return zero hits), so the exposure is
  third-party integrations only. These are API-key-authenticated public routes
  removed without a deprecation window; if you call them, switch to the scoped
  form.

### Changed

- **BREAKING: the launch body is validated. An unknown field is a `400`, not a
  silent drop.** The three launch surfaces handled an undeclared field three
  different ways: `POST /api/runs/remote` refused it (`.strict()`),
  `POST /api/runs/inline` stripped it (a non-strict `z.object`), and
  `POST /api/agents/{scope}/{name}/run` — which had no schema at all, only a
  `c.req.json<T>()` cast — ignored it and answered `201`. The last one is the
  failure that matters: the release above removed `config` from that body with
  no alias and no deprecation window, so a CLI, SDK or CI job still sending it
  got an accepted run executing with parameters nobody asked for, with no
  error, no log and no echoed field. Silently dropping a value the caller sent
  is how a run does something other than what was asked — the rule
  `assertFieldsUnlocked` already states, and the one `run_and_wait` was fixed
  on in the same release. Each surface now owns a `.strict()` schema for its
  own fields, and `parseRequestInput` receives an already-validated body
  instead of re-reading the request.

  Three observable changes, all on the way in:

  - an unknown field, or a declared field of the wrong type, is `400`
    `validation_failed` on all three surfaces;
  - a malformed JSON body is `400` instead of being swallowed into `{}` and
    launched as an input-less run (the `c.req.json().catch(() => ({}))`
    dialect `readJsonBody` was written to replace — the launch body was its
    last user in the API);
  - `dependency_overrides` on `POST /api/runs/inline` is `400`. It was
    accepted there and then dropped: `triggerInlineRun` never forwarded it, so
    a caller pinning a dependency got a run that ignored the pin.

  An empty body is still a valid launch (a run whose input resolves entirely
  from stored values sends none), and every documented field is unchanged.

- **`generation` is documented on the inline launch surfaces.** It was accepted
  and honoured by `POST /api/runs/inline` and `/inline/validate` but absent
  from the spec, so no generated client could reach it. The agent-run body is
  now registered in the Zod<>OpenAPI comparison, which is what turns that kind
  of drift into a failing check.

- **An agent declares ONE parameter schema, `input`. `config` is gone.** An
  AFPS manifest used to carry two — `input`, asked on every run, and `config`,
  set once at setup. Whether a value is asked every time or stored once is a
  deployment policy, not a property of the package, so it moved out of the
  portable format and into the platform: stored values plus per-field locks on
  `application_packages.input_settings`. AFPS 0.3 removes the field
  (afps-spec#16); `schema_version` still accepts any `0.x`, so a manifest that
  still carries `config` keeps validating — the platform simply ignores it.

  Input now resolves in four layers, last wins: author `default` keywords ->
  the application's stored values -> a schedule's frozen values -> the caller's
  input. A LOCKED field is refused from the last two with 400
  `locked_input_field` rather than silently dropped.

  This closes a real gap. `POST /runs` is gated by
  `requirePermission("agents", "run")` and nothing else, and the body accepted
  `config_override` with NO per-key check — so anyone who could run an agent
  could overwrite any stored value. Delegating an agent with fixed parameters,
  an admin pinning `days = 30` before handing it to their team, was not
  actually possible.

- **The platform prompt loses its `## Configuration` section.** Those values now
  render under `## User Input`. This changes the prompt sent to every agent.

- **The "configuration required" badge is gone.** With a single schema, an
  unfilled required field is simply asked at launch.

- **Migration `0040` folds every dropped column into its `input` counterpart
  before dropping it**, so no row loses a parameter: `application_packages.config`
  becomes `input_settings.values`, and `package_schedules.config_override` and
  `runs.config` merge into the respective `input`. On a key collision `input`
  wins, the same rule the manifest merge applies.

  **The manifest half was a separate, manual pass.** The DDL runs automatically
  at boot; rewriting manifests and `{{config.x}}` prompt references was done by
  `scripts/migrate-config-to-input.ts --apply`, which could only run afterwards
  because it read the renamed column. Until it had run, published agents still
  carried `{{config.x}}`, which the renderer resolves to the empty string with
  no error. That script was single-use and has since been deleted; nothing in
  the tree declares a manifest `config` section any more.

- **Three endpoints now report malformed JSON as `validation_failed` instead of
  `invalid_request`.** Two on `runs-events.ts` and one on `runs.ts`, as a side
  effect of routing their bodies through `readJsonBody`. The HTTP status is
  unchanged and no first-party client branches on the code, but `runs-events` is
  runtime-facing wire surface, so a third party matching on the string will see
  the new value.
- **`LOG_LEVEL` now reaches sidecar containers.** It was missing from
  `SIDECAR_OPERATOR_ENV_KEYS`, which made every `logger.debug` in the sidecar
  permanently unreachable under `RUN_ADAPTER=docker` and `firecracker`. Turning
  those diagnostics on is the point of the fix, so note the flip side: a host
  already running `LOG_LEVEL=debug` will now get debug output from sidecar
  containers where it previously got none. The default is `info` in both
  `.env.example` and `docker-compose.yml`.

### Fixed

- **Two indexes the schema declared but production never had** (#1182) —
  `idx_runs_package_started` and `idx_runs_schedule_id` were absent from the
  production database. They were the only two missing of the 132 indexes the
  schema declared when production was audited — 0039 has since dropped 18,
  leaving 114 — so every query planned around them had been running without
  them. Migration `0041_restore_squash_indexes.sql` creates both, guarded with
  `IF NOT EXISTS` because every database created FROM the squash already has
  them and the whole pending batch runs in one transaction — an unguarded
  `already exists` would abort the deploy for nearly every install.

  **Why nothing looked wrong.** `0000_init.sql` is a SQUASH and production
  predates it. Drizzle replays only the entries past a database's watermark,
  so for a database older than the squash `0000_init` is history, never
  pending work: anything the squash introduced by itself — rather than through
  a forward migration production also ran — silently never arrived. The
  bookkeeping was healthy throughout (39 rows, no gap), which is exactly why
  this went unnoticed; no migration was skipped and no record was wrong, only
  DDL was missing. The class is structural, not a one-off: the next squash
  reopens it for every index, constraint and default it introduces.

  **New operator check.** `DATABASE_URL=… bun scripts/check-index-drift.ts`
  reports every index the schema declares that a live database lacks and exits
  non-zero; `DATABASE_URL` is its only input, so it runs from a jump host with
  nothing but a production connection string. It diffs against the snapshot
  matching that database's OWN migration watermark, not the newest on disk (a
  database with migrations pending legitimately lacks the indexes they add),
  and refuses rather than guess when the watermark matches no journal entry.
  NAMES only — an index present under the expected name with lost uniqueness
  or a lost partial predicate reads as present. Run it against production
  after a squash. `apps/api/test/unit/migration-index-parity.test.ts`
  pins the rest in CI: it replays the journal into a throwaway PGlite and fails
  if the latest snapshot declares an index no SQL in the journal creates, then
  drops these two to model the production population and re-runs 0041 against
  it — both must come back, and the partial one must come back partial.

  **The rule this leaves behind:** a `DROP INDEX` must verify the SURVIVING
  index against the live database before dropping anything. Neither the TS
  schema nor `0000_init.sql` is evidence that an index exists in production —
  migration 0039 dropped `idx_runs_package_id` on the grounds that
  `idx_runs_package_started` covers it, and that cover was itself absent from
  production at the time.

### Security

- **The agent bundle export now requires each dependency type's read scope** —
  `GET /api/agents/{scope}/{name}/bundle` gated on `agents:read` alone. That
  covers the root agent, whose files the export narrows to `manifest.json` +
  `prompt.md`, but a dependency goes into the archive as its ENTIRE stored file
  map: a bundle carrying a skill hands out exactly the bytes
  `GET /api/packages/skills/{id}/files[/content]` serves, which #1123/#1124
  settled need `skills:read`. This route was the last looser door to the same
  content — a credential `403`'d on the file explorer was served the identical
  bytes here. The guard now runs against the ASSEMBLED bundle rather than the
  root manifest, so transitive dependencies are covered by construction and an
  unrecognised type fails closed. It gates on SCOPE, not visibility:
  dependency resolution stays org-scoped, so a bundle can still reach a skill
  that is not installed in the calling application, exactly like the run it
  mirrors.

  **Behaviour change for scoped credentials.** A credential holding
  `agents:read` but NOT `skills:read` now gets `403` where it used to get
  `200`, on both `?source=draft` and the published export, whenever the agent
  declares a skill dependency. In practice that is a scoped API key or OIDC
  token — every org role (owner, admin, member, viewer) carries both scopes, so
  no dashboard user is affected. An agent with no skill dependency is still
  exported to an `agents:read`-only key. Audit the scopes of any key that
  exports bundles from CI before upgrading.

- **Package file responses are never served from a fresh browser cache** —
  `Cache-Control: private, max-age=300` on the file explorer routes let a
  browser serve authenticated, tenant-scoped, RBAC-gated artifact bytes for
  five minutes with zero server contact. A revoked `<type>:read`, a member
  removed from the org, or a package uninstalled from the application all left
  the cached `200` being handed out until it expired, and `Vary` cannot rescue
  that — revocation changes no request header. Every response on both routes is
  now `private, no-cache`, which was already the behaviour for drafts,
  dist-tags, semver ranges and yanked versions. `no-cache` still permits the
  304 round-trip; it only forbids serving without one, and forcing that
  round-trip re-runs `hasPackageAccess` and the read-permission guard on every
  hit. **The trade**: a repeat view of the same file now pays a conditional
  request instead of reading the local cache. That revalidation answers a
  version's 304 from one DB read, with no storage GET and no unzip.

- **Package `GET` routes now enforce a read permission (#1123)** — every
  `GET` under `/api/packages` was gated on `hasPackageAccess` alone, which
  answers "is this package installed in this application, or a system
  package?" and nothing about what the caller may do. An API key scoped
  **without** `skills:read` could read a skill's manifest and its full
  `SKILL.md` (the detail route serves the authored `content`), and pull the
  published ZIP through `/{scope}/{name}/{version}/download`. Every `GET`
  on the router now requires the matching `agents:read` / `skills:read` /
  `integrations:read` / `mcp-servers:read`, and `/{version}/download`
  additionally goes through `hasPackageAccess` like the rest of the surface —
  it previously served artifact bytes for packages not installed in the
  calling application.

  **The read-permission change is breaking for API keys.** No org role loses
  access through the new RBAC guard (every role, down to `viewer`, holds all
  four read scopes), but a key minted without the matching `*:read` scope now
  gets `403` where it used to get `200`. Separately, the download visibility
  fix affects every caller: a package not installed in the calling application
  now returns `404`, including for org-role sessions. Audit issued key scopes
  before upgrading.

### Added

- **`integration_dropped` — a run that starts without an integration it
  declared now says so, in the run log** — "run with what you have" is a
  supported product mode: an agent whose integrations are only partly connected
  still starts, with the subset that resolved. It started SILENTLY, though. A
  run missing its Gmail tools looked exactly like a run whose agent simply
  chose not to call them, and the only trace was a `logger.warn` on the
  server, which the person reading the run page cannot see. The most common
  report was "the agent is ignoring my instructions", for a run that never had
  the tools those instructions name. `resolveIntegrationSpawns` now returns
  every drop alongside the specs, and the pipeline writes one `warn` `run_logs`
  row per dropped integration at kickoff — event `integration_dropped`, ordered
  before the container's own output, carrying `integrationId` and a
  machine-readable `reason` (`not_found`, `not_integration`,
  `invalid_manifest`, `not_installed`, `remote_url_missing`,
  `local_server_ref_missing`, `mcp_server_unresolved`,
  `mcp_server_not_runnable`, `no_delivery`, `resolve_error`) plus an optional
  `detail` when the reason alone is not actionable. It rides the same
  `pg_notify` → SSE path as the container's breadcrumbs, so it shows up live.
  Nothing about which runs start changes: a healthy run writes zero rows, and
  the marker swallows its own write failures so it can neither slow down nor
  fail a kickoff that is otherwise ready.

- **Opt-in observability module (#847)** — OpenTelemetry moves out of core
  behind the `@appstrate/core/telemetry` façade into a workspace module
  `@appstrate/module-observability`. Core ships zero OTel footprint; add the
  module to `MODULES` and set `OTEL_ENABLED` to activate tracing/metrics.

### Changed

- **A malformed `SYSTEM_INTEGRATIONS` entry now aborts boot instead of being
  skipped** — `initSystemIntegrations` logged an error and `continue`d past an
  invalid entry, a duplicate integration id, or a duplicate client id. The
  platform then came up looking healthy while serving a silently reduced
  offering, and the consequence surfaced somewhere else entirely: a dropped
  membership reads as "Integration 'X' is not installed in this application", a
  dropped client as "Administrator must register OAuth client credentials
  for …". Both blame application state for what is a typo in an env var, and
  both are found by whoever tries to connect — not by whoever deployed. A
  duplicate client id is worse than a drop: client ids are one global keyspace
  (a connection's `client_ref`), so the loser's connections would pin a ref
  that resolves to another integration's credentials, and there is no safe
  winner to pick. All three now throw at boot.

  **Operators: an upgrade against a pre-existing bad `SYSTEM_INTEGRATIONS`
  refuses to start.** That is the point — the deployment was already broken,
  just not where it was visible — but it means the fix belongs before the
  rollout, not after. The error names the entry's position in the array
  (`entry #2`), its `id` when the value survived far enough to be readable, the
  exact failing path (`clients[1].auth_key: …`) and, for a nested failure, the
  offending client by its own id, so a one-line env var does not have to be
  read by counting braces. Client secrets and system `client_id`s are redacted
  from the message, so it is safe to paste into a ticket.

- **`@appstrate/core` released as 6.2.0** — 6.1.0 was already published to npm,
  so the four export subpaths added since (`./package-files` and
  `./mcp-server-meta` from #1118, `./model-generation` from #1099, `./url` from
  #1122) could not be resolved by out-of-tree consumers installing from npm,
  even though the code ships in the tarball. Additive only, so a minor;
  `CORE_VERSION` moves with it. **Maintainers**: bump `cloud` and
  `connect-helper` to `^6.2.0` right after the `core@6.2.0` tag is pushed —
  leaving them at 6.1.0 makes the next core release compute a delta of 2 and
  hard-fail the lockstep gate.

- **Inline `run_and_wait` manifests are concise without becoming limited** —
  callers may omit AFPS boilerplate and provide only a task-specific
  `display_name`; the shared client derives the canonical name and fills
  runtime/output defaults before the existing full validation boundary. Any
  supplied field remains an exact override, including `runtime_tools: []` and
  complete deterministic schemas. The chat prompt prefers `run_and_wait` for
  launch-and-wait flows while keeping the fire-and-forget `runInline` and
  `runAgent` operations fully discoverable and invokable.

### Removed

- **`source_code` from the package create/update contract** — the
  `sourceFileName` plumbing behind it has been unreachable since the `tool`
  package type was dropped: no route config declared it, so `source_code` was
  never on the wire and sending one in a request body was already a no-op (such
  a body is still accepted, now stripped by non-strict Zod instead of parsed
  and ignored). No runtime behaviour changes — the published OpenAPI spec
  simply stops advertising a field that never existed at runtime, which
  `detect:breaking` reports as 27 response-field removals.

### Fixed

- **An absent `client_secret` registered a PUBLIC OAuth client nobody asked
  for, and put `client_secret=` on the wire** — `POST /api/integrations/{packageId}/auths/{authKey}/oauth-clients`
  declared `client_secret: z.string().default("")`, and the storage encoder
  read that emptiness back as "this is a public client". So an admin who
  selected `client_secret_basic` and forgot to paste the secret got `201` and a
  registered public client, and the failure arrived much later, from the
  provider: the token request went out carrying `client_secret=` — the
  parameter PRESENT but empty, which is not the same thing as absent — and
  Dropbox answers that with `invalid_client`. This was a real customer
  incident, and every layer of it was an inference nobody had written down.
  A public client is now DECLARED, never inferred — sending
  `token_endpoint_auth_method` as `"none"` says the app has no secret at the
  provider, which is a statement the platform cannot make on the admin's
  behalf. Both directions of the pair are guarded — `"none"` with a secret is
  refused (the caller resolved a credential and then said it would not be
  used), and a secret-based method, or no method at all (which means "the
  manifest's method applies"), without a secret is refused too. The same rule
  now governs the env-sourced half of the
  surface: a `SYSTEM_INTEGRATIONS` client is declarable in exactly the same
  terms, and refusing there is a boot crash rather than a `400`.

  **Breaking for anything that registers a public client the old way.** A
  request that omitted `client_secret`, or sent `""`, and relied on the
  platform inferring a public client now gets `400` instead of `201`; add
  `"token_endpoint_auth_method": "none"` and drop the secret. On the update
  route the rules differ deliberately, because absence there means PRESERVE:
  omitting `client_secret` still leaves the stored secret untouched (the rotate
  form submits an empty input whenever only the redirect URI changed, so the
  two must stay distinguishable), while an EXPLICIT empty string clears the
  stored ciphertext and is accepted only together with
  `token_endpoint_auth_method: "none"`.

- **A refresh that answered `200` with no `access_token` was recorded as a
  success — and disarmed every later check** — `performRefreshTokenExchange`
  substituted the caller's CURRENT access token when the response body carried
  none (`access_token: raw.access_token ?? opts.accessTokenFallback`). The
  refresh then "succeeded": it re-persisted the very token it existed to
  replace, cleared `needsReconnection`, and reset the failure streak. Worse,
  such a body carries no `expires_in` either, so the row lost its `expiresAt`
  — after which neither the proactive refresh lead window nor the streak
  escalation could ever fire again. A dead credential stayed marked healthy,
  indefinitely, and the only symptom was the agent's own upstream `401`s.
  Producers of that body are real: IdPs that answer `200 {"error":"invalid_grant"}`,
  captive-portal JSON, a bare `{}`. The fallback is gone; such a response now
  fails and increments the streak like any other refresh failure.

  **New failure class for operators**: connections against a provider with that
  behaviour will start reporting refresh failures and flip to
  `needsReconnection` where they previously reported nothing. They were already
  broken — this is the first release in which that is visible. The RFC 6749 §6
  case is untouched and deliberately so: an omitted `refresh_token` still means
  "keep the one you have", which non-rotating providers (Google, Slack, GitHub)
  depend on.

- **A run whose pinned version was deleted mid-flight silently executed the
  mutable draft** — `getRunEffectiveAgent` fell back to the live draft when the
  `package_versions` snapshot named by `runs.version_ref` was gone, with a
  `logger.warn` as the only trace. That fallback decided two things it had no
  business deciding: the run token's authorization set (what the sidecar may
  reach) and the run's output contract (what counts as success), both
  re-derived from a definition the run never agreed to. The internal run-token
  guards now answer `409 run_definition_gone` and name the deleted version and
  the remedy — re-publish it, or start a new run against the current
  definition — and finalize fails a run that would otherwise have landed on
  `success` against a contract nobody could read. A run that already terminated
  non-success keeps its own, more specific cause.

  Deleting the AGENT mid-run is a different state and stays benign: `runs.package_id`
  is `ON DELETE SET NULL` precisely so the run row survives for observability
  and billing, so such a run still finalizes on whatever status the runner
  declared, with output validation skipped because there is no contract left to
  validate against. The internal guards report it as `409 run_agent_deleted`,
  with a remedy that does not pretend re-publishing a version would help. The
  two states are distinct values in the result type so they cannot be collapsed
  by accident — collapsing them would mark every in-flight run of a deleted
  agent `failed`, a fabricated verdict about work that may have completed fine.

- **Every connect-run failure collapsed into one opaque `500`** — the hosted
  connect form returned `internal_error` whether the login tool had rejected
  the user's own password, the deployment could not run a connect-run at all,
  or the login simply took too long. Nothing in that response told the user
  whether to retype something, wait, or call an administrator. Failures are now
  typed by audience: a rejection the LOGIN TOOL itself reported ("wrong
  password", "MFA required", "captcha") comes back as `400` carrying the tool's
  own diagnostic, clipped so a runaway upstream body cannot be pasted wholesale
  into an API response; a backend that cannot host a sidecar-only workload
  comes back as `503 connect_unavailable`; a login that outlives the timeout
  comes back as `504 timeout`. Everything else on that channel stays an opaque
  `500` on purpose — `POST /api/integrations/connect/submit` is reachable by
  someone who is not a member of the organization, and sidecar-internal
  messages can carry host paths, namespaces and env-var names. For the same
  reason the `503` says "contact your administrator" rather than naming
  `RUN_ADAPTER`; the operator-facing remedy is logged at the throw site
  instead, where the operator is the one reading.

- **`GET /internal/integration-credentials` answered `200` with an empty
  payload for three states where a credential was expected** — the sidecar
  reads an empty payload as "this integration declares no `delivery.http`
  auths, skip the MITM listener entirely" and boots the run anyway. So a
  connection that had been deleted or unshared since kickoff, an `auth_key` the
  run's pinned manifest version no longer declares, or credentials that no
  longer decrypt all produced a run that started with zero credentials and an
  agent reporting a phantom upstream outage against a fleet of uncredentialed
  `401`s. An empty payload now means one thing only: the integration declares
  no auth. The three broken states fail instead — `404` when there is no
  connection to resolve (nothing exists to flag, so deliberately not a `410`),
  `409 integration_auth_undeclared` when the frozen manifest version does not
  declare the connection's auth (the credential is intact and may be valid
  under another version, so it is deliberately NOT flagged `needsReconnection`
  — a `410` there would destroy a working connection over a manifest edit), and
  `410` when the credential is genuinely dead. A `410` from either endpoint now
  also stamps the run's `metadata.degraded_integrations[]`, so the finished run
  shows a reconnect banner instead of the gap living only in the agent's
  transcript.

- **Saving an integration destroyed its `INTEGRATION.md`** — `draft_content` is
  overloaded for integrations: the importer stores the bundle's
  `INTEGRATION.md` when it ships one and the manifest text when it does not,
  with nothing on the row saying which. The package editor authors a manifest
  and has no documentation field, so it always wrote the manifest form —
  opening a documented integration and pressing Save, with no edit, replaced
  its documentation with its own manifest JSON. The integration then stopped
  contributing its agent-facing docs to every agent's platform prompt, and the
  file explorer served that manifest under the name `INTEGRATION.md`, the entry
  it pre-selects. Version restore and package fork produced the same corruption
  by other routes. All four write paths now agree on which entry the column
  mirrors, and the explorer declines to show a manifest copy over a real
  stored file.

  **Operators: existing rows are not repaired automatically.** The file
  explorer is fixed at read time — the real `INTEGRATION.md` is still intact in
  object storage and is served again immediately. The platform prompt is not:
  an integration whose column was already clobbered keeps contributing no
  documentation to agent runs until its row is repaired. Re-importing the
  integration's AFPS archive, or restoring a published version that ships the
  doc, rewrites the column correctly. No backfill migration ships with this
  release.

- **`POST /api/packages/import-bundle` skipped agent integration validation
  entirely** — bytes `POST /api/packages/import` refused imported cleanly
  through it and froze a broken selection into an immutable version. The same
  checks now run there as a pure-read preflight before the first write: one
  invalid agent aborts the whole bundle, and each field error names the
  offending `@scope/name@version`.

- **The publish-time integration check read the integration author's draft
  manifest, not the version the agent pinned** — an agent pinned to `^1.0.0`
  was refused at publish the moment that integration's author dropped
  `default_tools` from their _draft_, even though the run would have resolved v1
  and worked. The check now judges the manifest at the version the pin resolves
  to. A pin that resolves to nothing is left unjudged rather than rejected — that
  run already fails upstream with `dependency_unresolved` (422).

- **The publish-time check read a local integration's mcp-server catalog from
  that package's draft** — a `source.kind: "local"` integration takes its tool
  catalog from a separate `mcp-server` package, and the spawn resolver reads it
  at the version `source.server.version` resolves to. The validator called
  `fetchMcpServerManifest`, which reads `packages.draft_manifest`. Both
  directions were wrong: a tool the mcp-server author had only in their draft
  passed publish and then registered nothing at boot, and a tool present only in
  the published version was refused. Freeze points now call
  `resolveMcpServerForSpawn` — the resolver the spawn path itself uses.

- **An integration entry that was both empty and mis-scoped reported one error
  at a time** — `{ tools: [], scopes: ["bogus"] }` returned `no_tools_selected`
  alone, hiding `scope_not_in_catalog` until the next republish. Both are
  reported in one pass.

- **A model provider credential could become impossible to delete** —
  `GET /api/models` dropped every model whose credential could no longer serve
  inference (a revoked OAuth refresh token, or a stored secret that no longer
  decrypts). Since `org_models.credential_id` is `ON DELETE RESTRICT`, that
  produced a deadlock seen in production: the model was invisible in the UI, so
  it could not be detached, so its credential answered 409 `credential_in_use`
  forever. Such a model is now LISTED with a new `needs_reconnection` field on
  `OrgModel`, marked in the models table and in every picker, and still
  deletable — detaching it is what frees the credential. The write and runtime
  paths stay fail-closed: it cannot be selected in a picker, cannot become the
  organization default (409 `model_needs_reconnection`), is refused by the chat
  model resolver, and still resolves to null for inference. The `metadata_only`
  query parameter on `GET /api/models` is removed: a row must be decrypted to
  know its liveness, so the parameter no longer skipped any work.

- **A raw credential starting with a scheme name was silently corrupted before
  it reached the upstream (#988)** — `normalizeAuthScheme` ran on the RESOLVED
  `Authorization` value, after credential injection, so its
  `/^(Bearer|Basic|Token)(?=[^\s])/i` matched any secret whose first bytes spell
  a scheme name and injected a space mid-token: `basically_a_key_123` went out
  as `basic ally_a_key_123`, `tokenlive_sk_123` as `token live_sk_123`. The
  upstream answered 401 and nothing logged the rewrite, so a platform-side
  mutation looked like the user's credential being invalid. Two live paths could
  put a bare secret there: an integration declaring `credential_header_name:
"Authorization"` with no prefix, and a model writing `Authorization:
"{{api_key}}"` through the free-form `api_call` headers surface. The repair
  now runs on the caller TEMPLATE before substitution, anchored on `{{`
  (`Bearer{{access_token}}` → `Bearer {{access_token}}`), which covers the
  authoring defect it exists for with no false positives — a template is never a
  secret. The post-injection pass is gone from both entrypoints; it could never
  have repaired the declarative path anyway, since
  `buildInjectedCredentialHeader` builds `${prefix} ${token}` itself and so
  always had its space. There, the pass could only ever corrupt.

- **63 system packages shipped fixes production never served (#928)** —
  production logged 63 `level:50` "System package content changed without a
  version bump" errors at every boot since beta.39. The guard is correct — it
  refuses to overwrite a published, immutable version — and the consequence was
  that source changes to those packages were inert in production, including
  #907 (clickup/gmail/github MCP tool-policy sync) and #927
  (`clickup_download_task_attachment`): both shipped, neither ever live. Which
  packages drifted was measured, not inferred: `zipArtifact` is deterministic
  (sorted keys, fixed mtime), so each committed archive must still equal its
  bytes at the commit that minted its version. Byte-comparing all 66 gives 63
  drifted and 3 clean, and the 3 clean ones are exactly the 3 production does
  not report. Each of the 63 gets a patch bump, so `syncCanonical` (highest
  semver) makes the corrected content canonical on the next boot. Nothing is
  destroyed: the immutable `1.0.0` rows stay for anything pinned to them, and
  the sync prunes no versions. **Note for operators**: an install that pinned an
  explicit `version_id` keeps resolving the old row until re-pinned; installs
  that never pinned (`version_id` NULL, the default) pick up the new version
  automatically.

- **The test harness ran two post-incident guards as no-ops (#989)** — the
  harness called `mod.createRouter?.()` straight off each discovered module, so
  `init(ctx)` never ran and modules with a no-context fallback served every test
  request against a degraded baseline. For chat that meant the #968/#971
  admission gate answering `null` (fail-open) and the #965 document teardown
  resolving to a no-op, so any test that believed it exercised either guard
  exercised nothing and would have stayed green if the guard were deleted.
  Production was never affected — `_modules.set(...)` runs only after
  `await mod.init(ctx)` returns, and `registerModuleRoutes` iterates `_modules`
  exclusively. The preload now runs the same topo-sorted init pipeline as
  production, and with the harness at parity the chat fallback has no remaining
  consumer: `buildChatPlatformDeps(ctx)` takes a required context and
  `createRouter()` throws instead of serving a baseline that looks like it
  works.

- **`POST /api/packages/mcp-servers` published manifests no schema had ever
  accepted (#987)** — mcp-server is the only package type whose create reaches
  the `parsePackageUpload` branch, and that branch skipped validation two ways:
  a `manifest.json` missing or malformed inside the uploaded archive was
  swallowed into `undefined` by a non-throwing parser, and `manifest` was
  optional in the JSON body. Either way `createOrgItem` synthesized a
  `{version, name, $schema, type}` stub and `createVersionSafe` snapshotted it
  into `package_versions.manifest` — a published, immutable row failing
  `mcpServerManifestSchema` on `manifest_version` and `server`. The same
  corruption was reachable with a perfectly valid manifest of the WRONG type:
  `validateManifest` dispatches on the manifest's own root `type`, so a `skill`
  manifest posted to the mcp-server route validated happily and `createOrgItem`
  then rewrote `type` to the route's type AFTER validation. Manifest validation
  on create is now unconditional, and one direction-aware gate
  (`validateManifestForRoute`) rejects a route/manifest type mismatch with a
  `manifest.type` field error on create and on `PUT` supplying a manifest — the
  stored direction (`PUT` carry-forward, publishing an existing draft) keeps
  tolerating drift, because #983 settled that already-persisted artifacts are
  tolerated on read and a gate there would make a legacy drifted draft
  permanently un-publishable. The `type` stamping left `createOrgItem` for a
  pure `buildStoredManifest` that throws on divergence; `forkPackage` — the one
  caller whose sources can legitimately disagree, reading an immutable
  published snapshot — keeps the repair, now explicit and logged.
  **Behavior change for integrators**: an archive without a valid
  `manifest.json`, or a JSON body without `manifest`, is now a `400` instead of
  a silently stubbed package, and the JSON body's `version` field is gone (it
  was only ever read by the fallback that fired when `manifest` was absent).

- **Two contract holes: forks minted un-normalised manifests, stale modules
  booted silently (#974, #973)** — a fork is a READ that MINTS: it copies an
  already-published (immutable, therefore unrepairable) manifest into a brand
  new draft row, draft files, version row and ZIP. It copied verbatim, so a
  `runtime_tools` id the platform has since retired was regraved into an
  artifact minted today. The manifest is now normalised ONCE, before the draft
  row is written, so the four sinks can never disagree; the drop is structural
  (no Zod re-parse), so a source with nothing to drop keeps its key order and
  materialises no defaults, leaving publish dedup (#896) untouched. A source
  invalid for any OTHER reason is logged, never rejected: manifests today's
  validator refuses do sit in the catalog — the provider→integration migration
  (#481) left `type: "provider"` rows behind (the write direction that could
  still mint new ones is closed in #987) — and a gate would make them
  permanently un-forkable.

  The module→platform half of the contract is invisible to `tsc` for an
  out-of-tree module, and it fails silently: core 6.0.0 made
  `checkUsageAllowed`'s `subscription` flag required, and a 5.x caller omitting
  it reports a subscription turn as platform-funded. The loader now reads the
  `@appstrate/core` range from a module's own `package.json` and checks it
  against the platform's `CORE_VERSION` at boot. **Operator-facing**: the new `MODULE_CONTRACT_ENFORCE`
  var defaults to `warn` (log the mismatch, boot anyway) — only because this
  build ships core 6.0.0 while npm still serves 5.0.0, so no out-of-tree module
  can declare `^6.0.0` yet. The intended end state is `fail`; set
  `MODULE_CONTRACT_ENFORCE=fail` once every module you load has been
  republished against the published major.

- **Self-host: hosted connect portal broken out of the box (#905)** — no
  distribution path ever provisioned `CONNECT_SESSION_SECRET`: the installer
  didn't generate it and no compose template forwarded it, so the integration
  "Connect" button 503'd on every `appstrate install` deployment (dev, which
  reads `.env.example` directly, kept working). The installer now generates the
  secret on every tier, upgrades backfill it into existing `.env` files via the
  standard merge, all five compose templates forward it with a `:?` loud-fail,
  and a lockstep guard test (`install-secret-lockstep.test.ts`) fails the build
  if a generated secret is ever missing from a template again (both drift
  directions). **BREAKING for hand-managed deployments**: the env schema now
  requires `CONNECT_SESSION_SECRET` (boot fails without it — the hosted portal
  is the primary connect surface, not an optional feature). CLI-managed
  installs are migrated automatically on upgrade; operators who manage `.env`
  by hand must add `CONNECT_SESSION_SECRET=$(openssl rand -hex 32)` before
  deploying this version. The now-unreachable 503 response is removed from the
  `initiateIntegrationConnect` OpenAPI contract.

- **`api_upload` never exposed on `@appstrate/google-drive` (#881)** — the
  integration tool catalog listed only `api_call`, so the agent editor's tool
  picker never offered `api_upload` and importing an agent that selected it
  failed with `unknown_tool`, even though the sidecar advertises the tool at
  runtime for every auth declaring `upload_protocols`. The catalog now surfaces
  the companion, and the spawn resolver grants the `api_call`/`api_upload` pair
  from either name (upload chunks are dispatched through the sibling api_call
  tool, so a half-selection is never valid). No manifest change was required —
  `upload_protocols` was already in its documented `_meta` location.

- **Multi-auth `api_call` tools collided on one name (#881)** — an integration
  opting several auths into `_meta["dev.appstrate/api"]` exposes one tool per
  auth (`api_call__{authToken}`), but the sidecar collapsed every def onto the
  bare `api_call` name. The two registrations collided and `McpHost` silently
  disambiguated the second to `{ns}__api_call_2` — a name no catalog advertises
  and no agent can select. Trusted defs now keep the auth suffix through
  `McpHost`, and every auth of a serverless integration shares its allocated
  namespace. The agent-side upload extension pairs an `api_upload` tool with
  its `api_call` sibling by marker key scoped to that namespace, instead of a
  globally ambiguous key or a tool-name rewrite. Privileged api capability
  markers are stripped from non-trusted MCP descriptors so a third-party server
  cannot impersonate the sibling and receive upload chunks. Long AFPS auth keys
  now use one shared bounded token across the platform and portable runtime;
  persisted raw long-key selections/defaults/hidden names remain accepted and
  are canonicalised at the boundary. Declared synthetic names also take
  canonical precedence over same-named native MCP tools, avoiding `_2`
  runtime-only names that the catalog cannot select.

- **`hidden_tools` bypassed synthetic API tools (#881)** — the in-process
  `api_call`/`api_upload` registration now applies the same runtime
  `hidden_tools` filter as local and remote MCP integrations. Hiding
  `api_upload` therefore removes it from both the platform catalog and the
  final agent-facing MCP surface; hiding `api_call` also removes its dependent
  upload companion so no orphan capability is advertised.

- **Digit-leading integration scopes aborted the run (#881)** — a package
  published under a scope starting with a digit (`@1password/connect` is a
  valid AFPS id) produced a `1password_connect__api_call` name that the MCP
  tool-name pattern rejected, so the trusted registration path failed the
  integration and killed the run. The namespace half of the pattern now
  matches the slug alphabet (digit-leading allowed); the tool half is
  unchanged.

- **Phantom "selected tool unavailable" warning (#881)** — the sidecar's
  no-silent-degradation guard compared the agent's full tool allowlist against
  the count of the integration's own MCP tools that survived registration. The
  synthetic `api_call`/`api_upload` tools are served by a separate in-process
  server and were never counted, so any agent selecting them alongside a native
  tool got a spurious warn breadcrumb. They are now discounted from the
  requested set.

- **Transparent egress for `delivery.env` integrations (#850, #779)** — the
  sidecar no longer drops egress for integrations that inject credentials via
  `delivery.env`; the per-run proxy path is applied transparently.
- **OIDC cross-context PKCE resume (#852)** — the end-user OAuth flow survives
  a cross-context resume (invite-signup state mismatch) instead of failing the
  PKCE exchange.
- **`PUT /api/models/:id` enforces the model-alias invariants (#875)** — the
  update route now runs the same alias checks as create on the effective
  post-update state (explicit label, body-`model` protocol, no
  oauth-subscription credential), closing a bypass where a row could be
  flipped to `aliased` — or re-pointed to an oauth credential — into a state
  creation rejects. The subscription chat resolver also fail-closes on a
  legacy aliased oauth row instead of executing its hidden binding.
- **`maxTokens < contextWindow` enforced on the effective model state (#875)**
  — `POST`/`PUT /api/models` used to check the token-budget invariant only
  when both fields rode in the same payload; a lone `maxTokens` override could
  exceed the catalog (or stored) `contextWindow`, or a `modelId`/credential
  change could swap the catalog defaults under a kept override. Both routes
  now validate the effective pairing (payload → stored override → live
  catalog) before writing.

### Security

- **The agent runtime image ships only the bundled entrypoint, not the platform
  sources** — the image copied its own build inputs into the runtime stage
  (every `@appstrate/*` workspace `src/` tree, `runtime-pi/mcp/`, the
  `runtime-pi/*.ts` bootstrap files), all of which `bun build` had already
  inlined into `dist/entrypoint.js`, the ENTRYPOINT. They were dead weight that
  happened to be readable, and a confused agent read them and acted on what it
  found. No secret was exposed and the zero-knowledge boundary held. **This is
  not a confidentiality boundary** — the public `SECURITY.md` documents the same
  design in more detail. What changes is what the sandbox can read _without
  egress_. The bundle is deliberately NOT minified: `--minify-whitespace`
  was tried and reverted, because collapsing 1023 lines to 2 destroys the line
  and column of every production stack trace, and all it bought was hiding the
  per-module `// packages/core/src/…` banners. Concealment is not what this
  change is for.

- **Full-codebase security review remediation (#855, #863)** — 9 P0 + 15 P1 +
  12 systemic findings closed (SSRF `guarded-fetch` + bounded unzip hardening
  in `@appstrate/afps-shared`, among others), followed by a DRY/KISS/YAGNI
  audit-follow-up pass.

### CLI

- **Runner download progress + `runner uninstall` (#845)** — the CLI streams
  the daemon binary download with progress and adds a `runner uninstall`
  command.

### Documentation

- **Firecracker execution backend (#844)** — surfaced across the user-facing
  docs.

### Changed

- **A declared integration that exposes no callable tool now fails, instead of
  degrading silently** — BREAKING for agents in that state. Declaring
  `dependencies.integrations["@scope/x"]` while selecting no tool used to boot
  the run with nothing callable from it, announced only by a `warn` in the
  platform run log that never reached the model's context — leaving the agent to
  improvise unauthenticated HTTP from bash. The state is now refused in two
  places, with two different shapes.

  **Publishing and importing** — `POST /api/packages/agents/{scope}/{name}/versions`,
  `POST /api/packages/import`, `POST /api/packages/import-bundle` — answer
  `400 validation_failed` naming `integrations_configuration.<id>.tools`. That
  is the one moment the artifact is still editable, since a published version
  is immutable.

  **Creating** — `POST /api/packages/agents` — still answers `201`. The empty
  state is legal as a draft and the editor's flow passes through it; what
  changed is that the route no longer takes its usual initial version snapshot
  from a manifest publishing would refuse (a skip that `createVersionSafe` has
  always performed for a missing or invalid `version`). The draft is created,
  the author ticks a tool, and the first version is cut on publish.

  **At run boot** it aborts the run as a backstop. Draft `PUT`s are not gated
  at all.

  A **self-contained** bundle is judged too. Its integrations are not in the
  registry yet, so a DB-only validator hit "not installed → skip silently" and
  waved the agent into an immutable version; the catalog is now
  `incoming ∪ already-installed`, and the agent's `dependencies.integrations`
  spec is resolved against the catalog that will exist after import — including
  forward-only version creation, yanks, dist-tags and `latest` movement. Keying
  by package id alone, or preferring any carried match over a newer installed
  one, would judge a manifest the runtime will never use. The same lookup covers
  the mcp-servers a local integration references; system packages remain
  canonical even when a bundle carries a same-named manifest.

  The gate also tests CALLABILITY, not selection length. `default_tools: ["x"]`
  where `x` sits in `hidden_tools`, or is absent from the resolved mcp-server, is
  a non-empty selection that registers nothing; the effective selection is
  intersected with the same `resolveIntegrationToolCatalog` result the subset
  check uses. When the surface is genuinely unknown at publish time — a remote
  integration that enumerates nothing — the intersection is skipped rather than
  guessed.

  The runtime backstop stays necessary regardless: versions published before
  this gate existed are still runnable, and a draft can be run straight from
  the editor without ever being published.

  Blast radius: an absent `tools` key still inherits the integration's
  `default_tools`, which 59 of the 65 system integrations declare — for those,
  only an explicit `[]` is affected. The six that declare **no** `default_tools`
  are the exception, and they are widely used, so an absent `tools` key is
  enough to trip the gate there: `@appstrate/gmail-mcp`,
  `@appstrate/github-mcp`, `@appstrate/notion-mcp`, `@appstrate/clickup-mcp`,
  `@appstrate/canva-mcp`, `@appstrate/github-git`. Every one of them ships a
  populated `tools_policy` (7–91 tools), so the gate is always satisfiable from
  the editor — there is no manifest it can refuse without offering a fix. An
  agent in this state was already non-functional against that integration; it
  now fails loudly instead of silently.

  **Before deploying**, run `bun scripts/audit-empty-integration-selections.ts`.
  It lists every affected artifact and distinguishes active targets from
  explicitly selectable drafts/history. The exit code is 1 only when a normal
  application default or an enabled schedule targets the broken artifact;
  selector-only findings remain warnings, so an in-progress draft or immutable
  historical version cannot permanently jam the rollout gate. It calls the
  runtime's own resolvers rather than approximating them in SQL — a SQL version
  shipped first and was wrong three ways: it read the integration's draft
  `default_tools` instead of resolving the agent's pin, it ignored mutable drafts
  even though an installed package makes every artifact selector-runnable (and
  the editor explicitly runs the draft), and it ignored `dependency_overrides`.
  The audit now calls the same callability validator as publish/import, including
  the resolved nested mcp-server catalog and `hidden_tools`.

  This also corrects a documented falsehood — `tools` absent and `tools: []`
  were described as equivalent in the docs, the `ManifestIntegrationEntry`
  TSDoc and the LLM-facing MCP tool instructions. They never were: absent
  inherits, `[]` overrides.

- **Single Pi execution engine (#875)** — agent runs AND oauth-subscription
  chat (Claude Pro/Max via `claude-code`, ChatGPT via `codex`) all execute on
  the one Pi engine (`@mariozechner/pi-coding-agent`); the per-provider
  "official binary" run path and the Claude Agent SDK chat engine are removed.
  Pi's SDK emits each provider's subscription request shape natively — the
  platform forges nothing; the sidecar's oauth `/llm` mode is a pure
  bearer-swap (model aliases are rejected for oauth-subscription providers).
  Codex becomes chat-usable. The `#849` Claude-engine structured-output fix is
  superseded (that engine no longer exists; structured output flows through
  the Pi `output` runtime tool).
- CI action bumps: `docker/setup-buildx-action` 4.1.0→4.2.0 (#857),
  `actions/cache/restore` 4.2.4→6.1.0 (#858),
  `github/codeql-action/upload-sarif` 4.36.2→4.36.3 (#859),
  `actions/github-script` 7.0.1→9.0.0 (#861).

<!-- prior unreleased entries -->

### Added

- **Proxy-upload mode for S3 storage (#829)** — with `S3_PUBLIC_ENDPOINT`
  unset, upload URLs are now signed against `APP_URL`
  (`PUT /api/uploads/_content`) and the platform streams the body to the
  bucket server-side, so S3/MinIO can stay fully private (no published S3
  port, no second public FQDN). The installer's Docker-aware default tier
  moves from Tier 3 (bundled MinIO) to Tier 2 (filesystem storage) — MinIO
  adds no capability on a single node once serving is app-domain. The proxy
  sink now also binds the token's **exact declared size** (a completed body
  shorter than declared is rejected and rolled back, parity with the signed
  `Content-Length` of direct presign) and re-checks the **token expiry while
  the body streams** (a slow-trickled body can no longer hold the socket
  past the token window).

  **⚠ Behavior change for existing S3 deployments with `S3_PUBLIC_ENDPOINT`
  unset**: presigned URLs no longer fall back to `S3_ENDPOINT` — uploads
  route through `APP_URL` instead. Bytes now transit the platform (and your
  reverse proxy: check its body-size limit, see
  `examples/self-hosting/README.md` → Production Considerations), and
  `APP_URL` must be the instance's real public URL. To keep the previous
  direct-presign behavior, set `S3_PUBLIC_ENDPOINT` to your public S3
  endpoint. The platform warns at boot when proxy mode is active in
  production with a loopback `APP_URL`.

- **Inline file inputs on `runAgent` (#630)** — file-typed input fields now
  also accept RFC 2397 `data:<mime>;name=<filename>;base64,<payload>` URIs
  (≤4 MiB decoded) alongside `upload://` references. The bytes are written to
  the run workspace as a document with the same magic-byte MIME validation as
  staged uploads, and the payload is stripped from the persisted run input
  (compact `data:<mime>;name=<doc>;base64,` marker). JSON-only clients (MCP
  `invoke_operation`) can run an agent with a small file in a single call —
  no `createUpload` + signed PUT round-trips.

- **Unified memory surface (Letta-style `pin` / `note`, #273, ADR-011/012/013)** —
  `runs.state` + `package_memories` merged into a single `package_persistence`
  table with first-class `(actor_type, actor_id)` scope (`member` / `end_user`
  / `shared`). Two orthogonal attributes `(key, pinned)` collapse the previous
  `kind` enum into 3 quadrants (archive / pinned memo / pinned named slot).
  - System tools `@appstrate/note@1.0.0` (append archive) and
    `@appstrate/pin@1.0.0` (upsert named slot — `key="checkpoint"` is just
    one slot among `persona`, `goals`, `user_preferences`, …) replace the
    retired `@appstrate/add-memory` and `@appstrate/set-checkpoint`.
  - Always-on MCP tool `recall_memory` registered on the sidecar alongside
    `provider_call` / `run_history` / `llm_complete`.
  - REST API: `GET /api/agents/{scope}/{name}/persistence?kind=pinned|memory`
    plus targeted `DELETE` variants. Legacy `/memories` routes and the
    `memories:read|delete` permission are removed.
  - `RunResult.pinned: Record<string, PinnedSlot>` is the single wire-format
    surface; the temporary `RunResult.checkpoint` / `checkpointScope`
    top-level mirrors were dropped in #288.
  - Frontend: a single Memory tab on agent + run detail with two collapsibles
    (Pinned / Archive) and a scope filter (`All` / `Shared` / `Mine`).
- **AFPS Runtime extracted as `@appstrate/afps-runtime` (#227)** — portable,
  open-source bundle runner shipped as a workspace package (64 TS files):
  bundle loading + validation + SRI integrity, Ed25519 detached signing
  with trust-chain verification, conformance suite (L1–L4), event sinks
  (Console / File / HTTP / Composite) with Standard Webhooks HMAC and
  CloudEvents, Mustache rendering, credential providers (env / file /
  appstrate-backed), and a portable `afps` CLI (`run`, `test`, `sign`,
  `verify`, `keygen`, `inspect`, `render`).
  - New multi-package `.afps-bundle` format (`docs/architecture/BUNDLE_FORMAT_SPEC.md`):
    bundles an agent + its skills/tools/providers in a single artefact with
    Merkle-root integrity (per-file `RECORD` SRI → per-package SRI →
    bundle-level SRI on the canonical map). Endpoints:
    `GET /api/agents/:scope/:name/bundle` (export with `X-Bundle-Integrity`,
    `application/zip`) and `POST /api/packages/import-bundle` (accepts both
    `.afps-bundle` multi-package and legacy single-package `.afps`).
  - `apps/api/src/services/adapters/` shrinks ~1676 → ~1080 LOC (−35%) by
    delegating prompt assembly, stream parsing, lifecycle, reducer, runtime
    env contract, and signature policy to `@appstrate/afps-runtime`.
  - `tool-output@2.0.0` (breaking) — schema injected into `parameters.data`
    for constrained decoding, `replace-on-emit` semantics replace the prior
    deep-merge, run-level mismatch fails the run instead of warning.
- **Unified runtime protocol — single ingestion surface (#227 Parts 7–14)** —
  every run (platform container, remote CLI, GitHub Action) now POSTs
  HMAC-signed CloudEvents to `POST /api/runs/:runId/events` and
  `/events/finalize`. `AppstrateEventSink` is the sole writer.
  - DB migration 0006 — new columns on `runs` (`run_origin`,
    `sink_secret_encrypted`, `sink_expires_at`, `sink_closed_at`,
    `last_event_sequence`, `context_snapshot`) plus the new
    `credential_proxy_usage` table.
  - `POST /api/runs/remote` mints sink credentials (one-time secret,
    AES-256-GCM, 32-byte base64url); `PATCH /api/runs/:runId/sink/extend`
    refreshes the TTL.
  - LLM cost ledger renamed `llm_proxy_usage` → `llm_usage` with `source`
    enum (`proxy` | `runner`) and partial unique indexes per source.
    `aggregateRunCost` → `computeRunCost`; `finalizeRun` is the sole writer
    of `runs.cost`.
- **Runtime-pi on official MCP SDK (#281)** — agent tooling is **MCP-only**.
  Three canonical first-party tools (`provider_call`, `run_history`,
  `llm_complete`) replace the legacy `appstrate_<slug>_call` family. New
  `@appstrate/mcp-transport` workspace package adapts the MCP SDK to the
  AFPS tool format (`createMcpServer`, `createInProcessPair`,
  `createMcpHttpClient`).
  - Sidecar mounts `/mcp` (Streamable HTTP, stateless) alongside `/health`
    and `ALL /llm/*` (kept for in-container Pi SDK chat completion
    streaming). Tool descriptor poisoning hardening (Unicode strip,
    schema-property recursion) per CyberArk / Invariant Labs advisories.
  - Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes
    `process.env.SIDECAR_URL` so even the bash extension cannot discover
    the sidecar. The legacy `/proxy` and `/run-history` HTTP routes are
    fully retired — runners 1.x are not compatible with this branch.
  - `SIDECAR_MAX_REQUEST_BODY_BYTES` (default 10 MB) and
    `SIDECAR_MAX_MCP_ENVELOPE_BYTES` (default 16 MB) configurable; loud-fail
    at boot on invalid values; structured 413 errors carry
    `{ reason, scope, limit, actual, envVar, hint }`.
- **Authorized devices for CLI (#269)** — full lifecycle for `cli_refresh_tokens`.
  - Phase 1: head-of-family metadata (`device_name`, `user_agent`,
    `created_ip`, `last_used_ip`, `last_used_at`) — UA / device_name never
    re-captured at refresh (immutability of identity).
  - Phase 2: cookie-only user-facing endpoints `/api/auth/cli/sessions`,
    `/sessions/revoke`, `/sessions/revoke-all` (backing
    `appstrate logout --all`) plus a Devices preferences page.
  - Phase 3: org-scoped admin routes
    `GET/DELETE /api/orgs/:orgId/cli-sessions[/:familyId]` gated by the new
    module-owned RBAC resource `cli-sessions: read | delete` (owner +
    admin grants). Audit-log reasons distinguish `user_revoked`,
    `user_revoked_all`, `org_admin_revoked`.
- **Channel-aware CLI install + self-update (#270, closes #249)** —
  build-time `__APPSTRATE_INSTALL_SOURCE__` stamp lets the CLI dispatch
  upgrades correctly per channel.
  - `appstrate self-update [--release X] [-f|--force]` — curl channel does
    in-place upgrade with minisign + SHA-256, bun channel hints toward
    `bun update -g`.
  - `appstrate doctor [--json]` — detects every `appstrate` on `$PATH`,
    dedupes by realpath, displays the channel each was stamped with.
    Hidden subcommand `__install-source` exposes a stable JSON contract
    (`{ version, source, schema: 1 }`).
  - Bootstrap script + Commander `preAction` hook warn on dual install,
    persist ack at `~/.config/appstrate/dual-install-ack.json` keyed on
    sorted realpaths (re-arms when the set changes).
  - Channel matrix and recipes in `docs/cli/upgrades.md`.
- **Connect — OAuth/credentials hardening (#279)** — three findings closed.
  - Symmetric revocation handling: shared `parseTokenErrorResponse`
    between `handleOAuthCallback` and `forceRefresh`, RFC 6749 §5.2
    `invalid_grant` classification, typed `OAuthCallbackError`.
  - Scope validation: `parseTokenResponse` returns `scopeShortfall`
    (granted ⊊ requested) and `scopeCreep` (granted ⊋ requested) — short-
    fall flags `needsReconnection`, creep is logged without blocking.
  - Versioned encryption envelope: credentials now stored as
    `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
    (`CONNECTION_ENCRYPTION_KEY_ID` + `CONNECTION_ENCRYPTION_KEYS`). Legacy
    v0 raw-base64 envelope is fully retired.
- **OpenAPI coverage holes closed (#285, closes #284)** — `GET /api/library`
  added, all 5 verbs on `/api/credential-proxy/proxy` documented, and
  `verify-openapi` gains a static Code ⊆ Spec analyser that parses
  `apps/api/src/index.ts` to enforce ADR-004 ("OpenAPI = source of truth").
- **API surface polish (#280)** — `x-mutually-exclusive` extension on
  cursor-paginated endpoints, SSE `id:` field per HTML SSE spec for
  `Last-Event-ID` resume, additive `RunError` shape (`code`, `context`,
  `timestamp`) aligned with JSON-RPC 2.0 §5.1, 5 new
  `CanonicalRunEvent` variants (`run.started`, `run.succeeded`,
  `run.failed`, `run.timedout`, `run.cancelled`), credential-proxy
  response headers documented (`X-Stream-Request`, `X-Run-Id`,
  `X-Truncated`, `X-Truncated-Size`).
- **Self-hosting closed mode (#228)** — env-driven invitation-only deployments.
  - `AUTH_DISABLE_SIGNUP=true` blocks new account creation; pending
    invitations and platform admins still pass through (resolves the
    Infisical-style "invitation breaks when signup is disabled" pitfall).
  - `AUTH_DISABLE_ORG_CREATION=true` restricts `POST /api/orgs` to
    platform admins; org-less users see a "Waiting for invitation" page.
  - `AUTH_PLATFORM_ADMIN_EMAILS` declarative allowlist (no UI, no
    migration, IaC-friendly).
  - `AUTH_ALLOWED_SIGNUP_DOMAINS` email-domain allowlist with invitation
    override for external contractors.
  - `AUTH_BOOTSTRAP_OWNER_EMAIL` (+ `AUTH_BOOTSTRAP_ORG_NAME`) auto-creates
    the root organization on first signup of the configured email.
  - `bun apps/api/scripts/bootstrap-org.ts --owner=… --name=…` for explicit
    ops bootstrap with idempotent JSON output.
  - `appstrate install` integration: interactive prompt asks for the
    bootstrap admin email (Tier ≥ 1, fresh installs only); non-interactive
    via `APPSTRATE_BOOTSTRAP_OWNER_EMAIL=… curl|bash` for IaC. When set,
    the closed-mode trio is written into the generated `.env`.
  - Post-install action note: when bootstrap is configured, the installer
    prints the exact `<APP_URL>/register` link the operator must open.
  - `RegisterPage` reads `AUTH_BOOTSTRAP_OWNER_EMAIL` from `__APP_CONFIG__`
    and pre-fills + locks the email field, plus a banner explaining why,
    so the operator only has to pick a password (typo-proof bootstrap).
  - After signup, the bootstrap owner is routed through the rest of
    onboarding (`/onboarding/create` auto-skips since the org already
    exists, landing on the model-config step) so they can configure
    their first model, providers, and invite teammates.
  - The display-name field is also pre-filled (still editable) by
    deriving a sensible name from the locked email
    (`john.doe@acme.com` → "John Doe"), so the operator only has to
    type a password to complete signup.
  - Full guide in `examples/self-hosting/AUTH_MODES.md`.
- Health check for main application container in Docker Compose
- Named Docker networks with data tier isolation (`appstrate-data`, `appstrate-public`)
- Shared `tsconfig.base.json` with strict settings across all packages
- `test` and `lint` tasks in Turborepo pipeline
- Root `bun test` script
- Explicit `exports` field in `@appstrate/connect` and `@appstrate/shared-types`
- RFC 9457 `errors[]` array populated on every 400 validation response so a
  single round-trip lists every problem (manifest, config, input, providers)
  instead of surfacing them one at a time.
- `POST /api/runs/inline/validate` runs preflight in `accumulate` mode,
  returning the full list of validation errors in one response.

### Fixed

- **Presigned upload URLs rejected plain PUTs (#630)** — `createUpload`'s
  signed S3 URL embedded a placeholder `x-amz-checksum-crc32=AAAAAA==`
  (AWS SDK ≥3.729 default checksum behaviour signing the empty presign body),
  so S3 refused the upload unless the client reverse-engineered the real
  base64 CRC32 header. Presigning now opts out of request-checksum
  calculation: a plain PUT with the returned headers works. Integrity is
  unchanged — size and magic-byte MIME are still enforced at consume. The
  `createUpload` / `runAgent` OpenAPI descriptions now document the full
  upload→run recipe (and the stale `multipart/form-data` body on `runAgent`
  was removed — the endpoint is JSON-only).

### Changed — AFPS 2.0 conformance pass (2026-05-26)

- **System-package manifests** migrated to AFPS 2.0.2 canonical vocabulary: 6 manifests renamed `tools` → `tools_policy` per §7.8 (`integration-clickup-mcp`, `integration-github-mcp`, `integration-gmail-mcp@2.0.0`, plus three local-test fixtures); 6 manifests migrated from `{{credential.<field>}}` to Arazzo-canonical `{$credential.<field>}` placeholder grammar per §7.6/§7.7 (`integration-freshdesk`, `-teamwork`, `-twilio`, `-woocommerce`, `-wordpress`, `-zendesk`).
- **Integration credential wire** (`/internal/integration-credentials/*`) dual-emits AFPS 2.0 canonical snake_case (`auth_key`, `auth_type`, `authorized_uris`, `scopes_granted`, `delivery_plans`, `expires_at_epoch_ms`, `header_name`, `header_prefix`, `allow_server_override`) alongside deprecated camelCase aliases for one release window.
- **`IntegrationSpawnSpec`** carries a `sourceKind: "local" | "remote" | "api"` peer discriminant (replaces the synthetic `server.type: "http"` sentinel that collided with AFPS `mcpServerTypeEnum`).
- **OpenAPI** `AgentDetail.dependencies` gained the `mcp_servers` group; `library.packages` gained the `mcp-server` group.
- **Frontend**: `mtls` (AFPS 2.0.1 §7.2) handled by `FieldsConnectModal` via new `client_cert` / `client_key` fallback + multi-line textarea heuristic for PEM paste + new i18n labels (fr/en).
- **`required_identity_claims`** (§7.4) now enforced in both `oauth2-strategy` and `login-strategy`; missing required claims abort the connection before persistence.
- **OAuth discovery** (`packages/connect/src/oauth-discovery.ts`) now projects `code_challenge_methods_supported` and `userinfo_endpoint` from the discovery document; precedence is manifest > discovery > default `["S256"]` for PKCE methods.
- **New `mcp-server` runtime image** `appstrate-mcp-runner-uv` for AFPS 2.0.2 / MCPB 0.4 `server.type: "uv"`.
- **`INTEGRATION.md`** content surfaced to the agent at runtime via the platform-prompt's `### API Documentation` subsection (§3.5).
- **Bundle metadata** `BundleMetadata` dropped the `x-${string}` index signature (AFPS 2.0 §10.1 removes `x-*` in favor of `_meta` reverse-DNS namespacing).

### Documentation

- New ADR-015 (AFPS 2.0 sidecar MCP surface) supersedes ADR-003 + ADR-014; banner warnings on ADR-007 + ADR-013.
- New `docs/architecture/AFPS_2_0_INTEGRATIONS.md` covers `auths` multi-method, `mtls`, OAuth discovery, `identity_claims`, `scope_catalog`+`implies`, `delivery.{http,env,files}`, `source.kind`, `tools_policy`+`hidden_tools`, `_meta`, Arazzo `connect.login`, migration from 1.x.
- `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/guides/writing-an-integration-with-connect.md` rewritten / updated for AFPS 2.0 vocabulary.

### Changed

- Pinned Docker images to specific versions (postgres:16.8, redis:7.4, minio RELEASE.2025-03-12)
- Main Dockerfile now runs as non-root `bun` user in production
- ESLint `no-unused-vars` upgraded from `warn` to `error`
- All workspace packages extend shared `tsconfig.base.json`
- Enabled TypeScript type-checking on `runtime-pi` (previously disabled via `noCheck: true`)
- **BREAKING (API contract)**: `parseBody` helper — used by ~80 call sites
  across ~22 route files (core routes + `webhooks` and `oidc` modules) — now
  emits `code: "validation_failed"` instead of `code: "invalid_request"` on
  body-validation failures, and populates `errors[]` with every Zod issue
  instead of setting the top-level `param` field on the first one. Clients
  that branch on `code === "invalid_request"` or read `body.param` for
  body-validation errors must be updated to handle
  `code === "validation_failed"` and read the per-field `errors[]` array.
  Non-body validation errors (auth, app context, rate limits) continue to
  use their existing codes unchanged.
- **BREAKING (API contract)**: `validateAgentReadiness` now emits
  `code: "invalid_config"` for config-schema failures instead of the legacy
  `config_incomplete`, aligning with the inline-preflight stage that already
  used `invalid_config`. The field name and message are unchanged. Clients
  branching on `code === "config_incomplete"` must be updated.
- `validateAgentDependencies` parallelises provider checks via `Promise.all`
  across `isProviderEnabled`, `getProviderCredentialId`, and
  `getConnectionStatus`. The pre-existing check-type precedence (enabled →
  profile → credential → status → scope) is preserved; within each check
  type, the thrown error still follows `providers` iteration order. Happy-
  path latency is reduced.
- `ValidationFieldError` entries now carry an optional `title` (human-
  readable). Throwing wrappers (`validateAgentReadiness`,
  `validateAgentDependencies`, inline-preflight fail-fast) use it so the
  `Problem.title` field keeps its historical wording (e.g. "Empty Prompt")
  instead of surfacing the machine code.

### Removed

- **Sidecar pre-warming pool** — empirical measurement after #406 (parallel
  agent+sidecar boot with MCP retry) showed the agent's own Bun cold start
  fully masks warm-image sidecar boot, so pre-warming bought no user-visible
  latency. Cold-pull protection (20–45 s on first run after deploy) is now
  handled by `DockerOrchestrator.initialize()` calling `ensureImage()` for
  both images at API boot. Removed: `apps/api/src/services/sidecar-pool.ts`
  (~280 LoC), `POST /configure` endpoint, `CONFIG_SECRET` auth, standby
  network (`appstrate-sidecar-pool`), replenish loop, `preConfigured` flag,
  `SIDECAR_POOL_SIZE` env var, and host-port bindings on the sidecar
  container (agents reach the sidecar via the `sidecar` DNS alias on the
  run network — no host port needed). Sidecars are now spawned per-run with
  all runtime config injected via env vars at container start.
- **Pre-prod legacy purge (#288)** — five surgical removals exploiting the
  absence of production data on this branch (net −312 LOC, 36 files):
  - v0 credential-encryption envelope (raw-base64 fallback) — only the v1
    versioned envelope remains.
  - `RunResult.checkpoint` / `checkpointScope` top-level mirrors —
    `RunResult.pinned: Record<string, PinnedSlot>` is the single surface.
    The DB column `runs.checkpoint` is preserved for the per-run snapshot
    consumed by the `run_history` MCP tool.
  - CLI `LEGACY_PROJECT_NAME` install fallback (#167 pre-fix shim).
  - `legacyHashRedirects` prop and its 4 consumers.
  - `normalizeProviderInitialState` legacy draft repair.
- **Architectural redundancies collapsed (#290)** — net −90 LOC across
  10 files, zero behaviour change: `enrichOneSchedule()` removed (single
  Promise.all path via `enrichSchedules`), `proxyLlmCall()` returns
  `Response` directly (drop `ProxyCallResult` indirection), package
  config is sourced exclusively from `CONFIG_BY_TYPE` (drop standalone
  `SKILL_CONFIG` / `TOOL_CONFIG` / `AGENT_CONFIG` / `PROVIDER_CONFIG` and
  duplicate `TYPE_TO_CONFIG`).
- **Modernization audit cleanup (#291)** — 5 findings.
- Legacy run reducer + `LoadedBundle` mono-package surface (#247) —
  hot-path resolvers (`ToolResolver` / `SkillResolver` / `ProviderResolver`)
  natively consume `Bundle` multi-package; one canonical digest API
  (`canonicalBundleDigest(bundle)`).
- Legacy `/proxy` and `/run-history` HTTP routes from the sidecar — agents
  reach those capabilities exclusively via MCP `tools/call` now (hard
  break, no soft-deprecation).
- Invalid `preserve-caught-error` ESLint rule

### Security

- Non-root container execution for main application image
- Network isolation between data services and public-facing services
- **Versioned credential encryption envelope (#279)** — credentials stored
  as `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
  enabling rotation windows (active key embeds the kid, retired keys held
  for decrypt-only). Legacy v0 envelope retired.
- **MCP tool descriptor poisoning hardening (#281)** — `sanitiseTextField`
  strips Unicode hidden characters (zero-width, RTL/bidi, BOM,
  Hangul/Khmer fillers, C0 controls); `sanitiseToolDescriptor` recurses
  through `inputSchema.properties` to mitigate Full-Schema Poisoning
  (CyberArk / Invariant Labs advisories). Limits enforced: tool desc
  ≤ 2048 B, param desc ≤ 512 B, schema ≤ 8192 B.
- **Pi image hardening (#227 Part 14)** — image size 877 MB → 313 MB
  (−64%); `unzip` apk dropped (fflate in-process), explicit UID/GID
  (`pi`=1001, sidecar `nobody:nobody`), `COPY --chown` instead of bulk
  recursive chown.
