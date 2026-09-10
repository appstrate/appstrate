# Multi-file skill authoring — draft tree write path + editor

Status: proposed (2026-09-10). Customer need #1 of the 2026-09-09 call.

## 1. Problem, precisely

The storage, the run pipeline and the read routes are already multi-file. Only
the write path is single-file.

| Layer                        | Multi-file? | Evidence                                                                                     |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| Storage                      | yes         | one ZIP object per package, arbitrary entry map — `package-items/storage.ts:23`              |
| Import (ZIP / AFPS / GitHub) | yes         | `handleImport` stores `parsed.files` verbatim                                                |
| Read                         | yes         | `GET …/files` (index) + `GET …/files/content` (bytes) — `routes/packages.ts:2269, 2302`      |
| Draft run                    | yes         | `DraftPackageCatalog` downloads the stored ZIP — `run-launcher/draft-package-catalog.ts:116` |
| Publish                      | yes         | `createVersionFromDraft` freezes the stored ZIP + manifest — `package-versions.ts:670`       |
| CLI `skills sync`            | yes         | materializes every entry — `skills-sync/materialize.ts:99`                                   |
| **Write**                    | **no**      | `PUT /api/packages/skills/@s/n` takes ONE `content` string; the storage merge writes ONE key |

The merge at `routes/packages.ts:1084`:

```ts
const updatedFiles = { ...(existingFiles ?? {}), [rcfg.storageFileName]: bytes };
```

preserves ancillary files but can only ever write `SKILL.md`. Consequences: a
file other than `SKILL.md` can be created only by re-importing the whole
package, and can **never be deleted** by any route. There is no rename.

### What was wrong in the first framing

"Writing the ZIP directly loses the draft" is false. The draft/version split
already exists: the **storage ZIP is the mutable draft tree** and
`package_versions` holds the immutable copies. `packages.draft_content` is not
the draft — it is a second copy of the content entry (`SKILL.md` / `prompt.md`)
that the explorer overlays on the ZIP because the row is written before the
ZIP (`package-files.ts:22-27`). So **no new table, no migration**. The work is a
write route over the tree that already exists, plus keeping that one column in
sync.

## 2. State of the art (what the market converged on)

- **Anthropic Skills API / OpenAI Skills API** — a skill is a directory with
  `SKILL.md` at the root; a _version_ is an immutable full file set uploaded as
  multipart files or one ZIP; a `default`/latest pointer selects the active one;
  there is no per-file edit — editing means minting a new version. Exactly our
  `package_versions` + publish.
- **claude.ai custom skills** — upload a ZIP; multi-file skills open beside the
  chat and are edited through Claude ("Edit with Claude", batched across files).
  The in-browser editor is an _agentic_ edit surface over the same tree.
- **Windmill** — every script/flow has a **draft** (autosaved, debounced) and a
  **deployed** immutable version; a diff viewer draft ↔ deployed; conflict
  detection when the deployed version moves under an open draft. (Drafts are
  per user there — out of scope here, see §8.)
- **Cloudflare Workers** — the dashboard editor is VS Code for Web over multiple
  modules; _Save_ mints a version, _Deploy_ promotes it.
- **Supabase Edge Functions** — dashboard multi-file editor + deploy, explicitly
  no versioning ("for prototypes") — the counter-example.
- **GitHub Contents API / web editor** — tree + one file at a time; a write must
  present the `sha` of what it read (409 on mismatch). Optimistic concurrency by
  content hash, not by row counter.

Common denominators, all of which this plan keeps: (1) a mutable working copy
and immutable versions; (2) a tree with one file open at a time; (3) writes are
atomic against the whole set; (4) concurrency is guarded by a content validator.
Nobody models files as rows.

## 3. Decisions

- **D1 — The draft tree is the storage ZIP.** No schema change.
  `packages.draft_content` is rewritten whenever the write touches the type's
  content entry (`PACKAGE_CONTENT_ENTRY`), so the overlay in `applyDraftOverlay`
  never shows a stale `SKILL.md`. `lock_version` is bumped on every write, so
  the existing manifest `PUT` keeps its 409 semantics.
- **D2 — One write operation: `PATCH /api/packages/{scope}/{name}/files`.**
  Body: `{ operations: Op[] }` with
  `Op = { op: "write", path, text } | { op: "write", path, bytes_base64 } | { op: "delete", path } | { op: "move", from, to }`.
  Applied in order against the overlaid draft snapshot, validated as a whole,
  written once. Response `200 PackageFileWriteResult = { entries, lock_version }`
  with the new index `ETag` — the same body shape as the `GET` so the client
  replaces its cache with it. _Rejected: `PUT`/`DELETE` per file._ A rename
  would be two non-atomic requests, "save all" would be N requests each
  rewriting the ZIP, and every intermediate tree would have to be valid on its
  own (a tree with no `SKILL.md` for the duration of a move).
- **D3 — Concurrency: `If-Match` on the index ETag, `412` on mismatch, `428`
  when absent.** The index ETag is the content digest of the overlaid tree
  (`draftSnapshotId`) — "the tree I am modifying is the tree I read". `*` is
  accepted (RFC 9110: matches any current representation) for scripted callers
  that deliberately overwrite. Writers of one package are serialized with
  `pg_advisory_xact_lock(hashtext('package-files:' || id))` around
  download → apply → validate → upload → row update (precedent:
  `integration-connections.ts:2155`). The existing manifest `PUT` moves its
  storage merge onto the same helper: it has the same lost-update window, and
  two writers of one object must share one lock.
- **D4 — Validation of the RESULT tree, same rules as import:**
  - path predicate extracted from `unzipArtifact`'s filter into
    `@appstrate/core/zip` as `isSafeArchivePath(path)` (no `..` segment, no
    leading `/`, no `\0`, no `\`, no `__MACOSX/`, no trailing `/`, no empty
    segment). Import keeps _dropping_ offenders; the write _rejects_ them
    (`400`). One predicate, two policies.
  - `manifest.json` is not writable, deletable or movable here (`400`): the
    manifest is authored through the package `PUT` and validated by
    `validateManifestForRoute`.
  - the content entry (`SKILL.md` / `prompt.md`) cannot be deleted or moved
    (`400`); it can be written, and then passes the same gate as import:
    `assertArchiveContentConforms(type, files, "file")`.
  - a file may not shadow a directory nor a directory a file (`400`).
  - caps: `PACKAGE_FILE_INLINE_MAX_BYTES` (1 MiB) per written file,
    `PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES` (50 MB) and 10 000 entries for the
    tree (`413`). Larger binaries keep going through ZIP import (§8).
- **D5 — Enabled per type through `CONFIG_BY_TYPE`, not inferred.**
  `draftFilesWritable: true` on `agent` and `skill` only. `integration` and
  `mcp-server` carry executable bundles whose invariants are enforced by
  `parsePackageZip` at import/publish; opening arbitrary writes on them is a
  separate decision. A `PATCH` on those answers `400 package_type_not_editable`.
- **D6 — Authorization = the package `PUT`'s.** `requirePermission(type,
"write")` resolved from the package row, `requirePackageInOrg()`, system
  packages `403`, `rateLimit(30)`. Draft only — no `?version`: versions are
  immutable (Anthropic, OpenAI, Windmill, Cloudflare all agree).
- **D7 — Front: structural operations are immediate, content edits are
  buffered.** Create / rename / delete / upload each send one `PATCH` and
  replace the tree with the response; typing edits live in a `{ path → text }`
  map and are flushed by the editor's existing _Enregistrer_ as one `PATCH`
  (N `write` ops), followed by the manifest `PUT` when the manifest is dirty,
  threading `lock_version` through both. The server stays the only truth for
  the tree shape; the client never applies tree algebra. _Rejected: buffering
  structural ops too_ — it requires a client-side reducer replaying ops over
  the server index (rename of a dirty file, delete of a created file, …) for no
  user-visible gain at this scale. The existing unsaved-changes blocker covers
  the buffered text.
- **D8 — Scope of the UI change: the skill editor.** Its `SKILL.md` tab becomes
  _Fichiers_: editable tree on the left, Monaco (language by extension) or a
  binary card (download / replace / delete) on the right, `SKILL.md`
  pre-selected and pinned (no rename, no delete). The read-only explorer on the
  detail page is unchanged. The component is type-agnostic so the agent editor
  can mount it later (§8) — not in this PR.

## 4. Backend

### 4.1 `packages/core/src/zip.ts`

- `export function isSafeArchivePath(path: string): boolean` — the predicate
  currently inlined in `unzipArtifact`; `unzipArtifact` calls it. New core
  export ⇒ one line under `[Unreleased]` in `packages/core/CHANGELOG.md`
  (export-surface gate).

### 4.2 `apps/api/src/services/package-files.ts`

- `applyFileOperations(files, ops, ctx): Record<string, Uint8Array>` — pure,
  throws typed `PackageFileWriteError { code, path }`; codes:
  `invalid_path`, `reserved_entry` (manifest.json), `content_entry_immovable`,
  `not_found` (delete/move source), `path_conflict` (file↔dir shadowing),
  `file_too_large`, `tree_too_large`.
- `mutatePackageDraftFiles(pkg, precondition, mutate)` — the one
  read-modify-write for a package's draft tree:
  1. `db.transaction`: advisory lock on the package id;
  2. `readPackageSnapshot(pkg, draft)` (the overlaid tree — a fresh package
     with no ZIP still yields its `SKILL.md` + `manifest.json`);
  3. check `precondition` — `{ etag }` against `indexEtag(snapshot.snapshotId)`
     → `412`, or `{ lockVersion }` against the row → `409` (the `PUT`'s
     contract, unchanged);
  4. `mutate(files)` → new map; `assertArchiveContentConforms(type, files,
"file")`; caps;
  5. `uploadPackageFiles(folder, orgId, id, files)` — `manifest.json` is
     stripped before upload exactly as today's merge never stores it for
     skills/agents (the overlay re-adds it from `draft_manifest`);
  6. row update: `lock_version + 1`, `updated_at`, and `draft_content` =
     decoded content entry when it changed;
  7. return `{ snapshot, lockVersion }`.
- `makeUpdateHandler` (`routes/packages.ts:983`) replaces its
  `downloadPackageFiles … uploadPackageFiles` tail with a call to this helper
  (`precondition: { lockVersion: body.lock_version }`, `mutate` = set the
  content entry). Behaviour identical, one lock.

### 4.3 Route — `routes/packages.ts`

```
PATCH /api/packages/:scope/:name/files
  rateLimit(30) → loadOrgItemOr404 → requirePermission(type,"write") → system 403
  → CONFIG_BY_TYPE[type].draftFilesWritable || 400
  → If-Match required (428) → readJsonBody(patchFileOperationsSchema)
  → mutatePackageDraftFiles → 200 { entries, lock_version } + ETag + fileCacheHeaders
  → recordAuditFromContext("package.updated", { type, files: ops.length })
```

Zod: `operations` non-empty, ≤ 200 per request; `text` xor `bytes_base64`;
paths ≤ 1024 bytes. Every rejection is RFC 9457 through the existing helpers.

### 4.4 OpenAPI — `openapi/paths/packages.ts`, `openapi/schemas.ts`

- `patchPackageFiles` operation; `PackageFileOperation` (oneOf, discriminator
  `op`), `PackageFileOperations`, `PackageFileWriteResult`; `If-Match` header
  parameter; responses 200/400/401/403/404/412/413/422/428/429.
- `bun run generate:api` + `bun run openapi:baseline` (additive — `detect:breaking`
  stays green). `verify:api-types` goes red on any prose edit until regenerated.

### 4.5 Tests (API)

- unit `package-files.test.ts`: `applyFileOperations` matrix (each op, each
  error code, order dependence — `move` then `write` on the new path, delete
  of a file created earlier in the same batch); `isSafeArchivePath` positive
  and negative controls; byte-exactness of `text` round trip (BOM kept).
- integration `packages-files-write.test.ts`:
  - happy: write text, write base64 binary, delete, move, one batch with all
    four; `GET …/files` reflects it; `GET detail.content` reflects a written
    `SKILL.md` (draft_content sync); `POST versions` afterwards freezes the
    ancillary file (download the version ZIP, assert entry); draft run bundle
    (`DraftPackageCatalog`) contains the new file;
  - rejections: traversal / backslash / `__MACOSX` → 400 and storage
    untouched; `manifest.json` → 400; delete `SKILL.md` → 400; broken
    frontmatter in a written `SKILL.md` → 400, storage untouched; file > 1 MiB
    → 413; `mcp-server` package → 400;
  - preconditions: missing `If-Match` → 428; stale → 412; `*` → 200;
    `PUT` manifest with the `lock_version` from before the `PATCH` → 409, with
    the one returned → 200;
  - authz: `skills:read` only → 403; package of another org → 404; system
    package → 403; `agents:write` cannot patch a skill (guard resolved from the
    row's type, not the URL);
  - regression: the existing `PUT` still preserves ancillary files.
- Tier 0 (PGlite) must pass: `pg_advisory_xact_lock` is plain Postgres, verify
  in phase 1 before building on it.

## 5. Frontend

### 5.1 `apps/web/src/lib/package-file-tree.ts` (pure, tested)

- `languageForPath(path)` → Monaco language id (md, json, yaml, ts/js, py,
  sh, css, html, plaintext).
- `isPinnedEntry(type, path)` = the content entry.
- `validateNewPath(entries, path)` → the same rules as the server, for
  immediate feedback (`isSafeArchivePath` is importable from core).

### 5.2 `apps/web/src/components/package-files/`

- `editable-file-tree.tsx` — `ReadOnlyFileTree` gains an optional `actions`
  prop instead of a fork: row context actions (rename, delete) and a header
  toolbar (new file, upload). The pure keyboard/ARIA model is unchanged; `F2`
  = rename, `Delete` = delete, both no-ops on the pinned entry. Folders stay
  implicit (a path with `/`), as in the index.
- `package-files-editor.tsx` — owns: the `GET …/files` query, the `ETag` from
  its headers, `{ path → text }` dirty map, the selected path, and
  `usePatchPackageFiles` (one mutation, `If-Match` from the last index, replaces
  the query cache with the response and lifts `lock_version` to the parent).
  Right pane: `ContentEditor` for text (`languageForPath`), the existing
  `FilePreview` metadata card + _Remplacer_ / _Supprimer_ for binary or
  oversized. Dialogs: `NewFileDialog` (path input with live validation),
  `RenameDialog`, `ConfirmModal` for delete. Upload = `<input type=file
multiple>` → base64 `write` ops, client-side 1 MiB check with the same
  message the server would give.
- `PackageEditorInner` (`pages/package-editor.tsx`): the `content` tab becomes
  `files` and mounts `PackageFilesEditor`; `state.content` is removed from
  the skill editor state — `SKILL.md` is a file like the others. Save =
  `flushFiles()` then, if the manifest is dirty, the existing `PUT` with the
  `lock_version` the flush returned. `validate` keeps the frontmatter check on
  the dirty `SKILL.md` text (already the same checker the routes run).
  `useEditorState.isDirty` ORs in the dirty map so the unsaved-changes modal
  still fires.
- Creation flow (`isEdit === false`): `POST /skills` first (needs a manifest
  and a content), then the editor navigates to edit mode; files are added
  there. No change to the create route.

### 5.3 i18n — `locales/{fr,en}/agents.json`

`files.tabLabel`, `files.newFile`, `files.upload`, `files.rename`,
`files.delete`, `files.deleteConfirm`, `files.pathPlaceholder`,
`files.errorInvalidPath`, `files.errorReserved`, `files.errorTooLarge`,
`files.errorConflict` (412 → "Le package a été modifié ailleurs, rechargez"),
`files.pinnedHint`.

### 5.4 Tests (web + e2e)

- web unit: `languageForPath`, `validateNewPath`, `isPinnedEntry`.
- e2e `packages/skill-files-editor.ui.spec.ts` (label `e2e`): create a skill,
  add `scripts/run.py`, type, save, reload → tree + content persisted; rename
  to `scripts/main.py`; delete; `SKILL.md` has no rename/delete affordance;
  stale-tab scenario: second context patches, first context's save → 412
  message.

## 6. Delivery

Worktree `.worktrees/skill-files-editor`, branch `feat/skill-files-editor`,
labels `integration` + `e2e`. One Opus agent per phase, sequential, one shared
brief; supervisor reads each diff; two independent reviewers (authz+atomicity,
DRY/KISS) then one fix agent — the pattern that shipped #1307.

| Phase | Deliverable                                                                                                                           | Gate                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0     | this plan committed; brief for agents                                                                                                 | —                                                                                       |
| 1     | `isSafeArchivePath`, `applyFileOperations`, `mutatePackageDraftFiles`, `PUT` moved onto it, unit tests, tier-0 advisory lock verified | `bun test apps/api/test/unit/package-files.test.ts`, existing `packages*.test.ts` green |
| 2     | `PATCH` route, Zod, OpenAPI, generated client, integration tests                                                                      | `verify:openapi`, `verify:api-types`, `detect:breaking`, integration suite              |
| 3     | tree lib + editable tree + `PackageFilesEditor` + skill editor wiring + i18n + web unit tests                                         | `bun run check`                                                                         |
| 4     | e2e spec, CHANGELOGs (root + core), `docs/` API mention                                                                               | e2e job green                                                                           |
| 5     | two reviews + fix pass, conformance check, `/audit-legacy` on the diff                                                                | CI fully green, `bun run check`                                                         |

No migration. No env var. No `@appstrate/core` version bump beyond the
CHANGELOG line (additive export). Behaviour change for existing clients: none —
`GET` routes untouched, `PUT` contract untouched.

## 7. Risks

- **Whole-ZIP rewrite per operation.** Each `PATCH` downloads, unzips, rezips
  and uploads the package (≤ 50 MB). Acceptable at this scale and identical to
  today's `PUT`; the snapshot LRU the explorer plan deferred stays deferred.
- **Two writers, two guards.** `PUT` guards by `lock_version`, `PATCH` by
  ETag; both bump `lock_version` and both hold the advisory lock. A stale SPA
  tab gets a 409 or a 412 — never a silent overwrite. Tested explicitly.
- **`draft_content` drift.** The column is rewritten inside the same helper
  that writes the ZIP; `assertArchiveContentConforms` runs on the bytes about to
  be stored. Any future writer of the ZIP must go through the helper — the
  header comment says so.

## 8. Explicitly out of scope (follow-ups)

- Agent editor mounting the same `PackageFilesEditor` (one tab swap).
- CLI `appstrate skills push <dir>` (customer need #6) = diff local tree vs
  index, one `PATCH` with `If-Match` — the endpoint is designed for it.
- MCP tool `write_package_file` for "edit with the agent" (claude.ai's model).
- Binaries > 1 MiB through the editor (multipart `PUT …/files/content`).
- Per-user drafts (Windmill) — one draft per package is the current model.
- Draft ↔ latest-version diff view (Windmill / Cloudflare): the data exists
  (`?version=latest` index vs draft index); UI only.
