# Multi-file skill authoring — draft tree write path + editor

Status: shipped in PR #1312 (2026-09-10). Customer need #1 of the 2026-09-09 call.

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
    `@appstrate/core/zip` as `isSafeArchivePath(path)` (no `..` segment, no `.`
    segment, no leading `/`, no `C:/` drive prefix, no `\0`, no `\`, no
    `__MACOSX/`, no trailing `/`, no empty segment). Import keeps _dropping_
    offenders; the write _rejects_ them (`400`). One predicate, three policies:
    the CLI skills materializer takes the same import rather than restating it,
    and aborts the sync — its local copy had drifted, refusing `.` segments and
    drive prefixes the platform accepted.
  - `manifest.json` is not writable, deletable or movable here (`400`): the
    manifest is authored through the package `PUT` and validated by
    `validateManifestForRoute`.
  - the content entry (`SKILL.md` / `prompt.md`) cannot be deleted or moved
    (`400`); it can be written, and then passes the same gate as import:
    `assertArchiveContentConforms(type, files, "file")`.
  - a file may not shadow a directory nor a directory a file
    (`path_conflict`).
  - two of the names the batch ADDS that a filesystem cannot tell apart — equal
    after Unicode NFC normalization and case folding — are refused
    (`path_conflict`): a ZIP is a flat list of byte strings and can carry
    `SKILL.md` and `skill.md` at once, `~/.claude/skills` cannot. The rule is
    scoped to what this write introduces, so an author is not locked out of a
    package whose stored archive already holds such a pair.
  - caps: `PACKAGE_FILE_INLINE_MAX_BYTES` (1 MiB) per written file,
    `PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES` (50 MB) and 10 000 entries for the
    tree (`413`). Larger binaries keep going through ZIP import (§8).
- **D5 — Enabled per type through `CONFIG_BY_TYPE`, not inferred.**
  `draftFilesWritable: true` on `agent` and `skill` only. `integration` and
  `mcp-server` carry executable bundles whose invariants are enforced by
  `parsePackageZip` at import/publish; opening arbitrary writes on them is a
  separate decision. A `PATCH` on those answers `400 package_type_not_editable`.
- **D6 — Authorization = the package `PUT`'s**, reused whole rather than
  restated: the `PUT`'s `requirePackageInOrg()` gate, i.e.
  `assertPackageMutationAccess(c, id, "write")`. It settles the row lookup, the
  system-package `403`, and — because a draft tree is one object behind every
  installation — `<type>:write` in EVERY space the package is installed in
  (`403` otherwise), reachable at all only from a space that grants it or
  through org-catalog authority over a package installed nowhere (`404`
  otherwise). Not a hand-rolled row read plus permission check: gating on org
  ownership alone would let a builder in space A rewrite, through the file tree,
  a skill that only exists in the private space B. `rateLimit(30)`. Draft only —
  no `?version`: versions are immutable (Anthropic, OpenAI, Windmill,
  Cloudflare all agree).
- **D7 — Front: structural operations are immediate, content edits are
  buffered.** Create / rename / delete / upload each send one `PATCH` and
  replace the tree with the response; typing edits live in a
  `{ path → { text, base } }` map and are flushed by the editor's existing
  _Enregistrer_ as one `PATCH` (N `write` ops), followed by the manifest `PUT`
  carrying the `lock_version` the flush returned. `base` — the server text a
  buffer was composed against — is what keeps an overwrite VISIBLE: a
  structural operation that `412`s re-reads the index and hands the editor a
  live validator for a tree a colleague meanwhile wrote, so without it the next
  save would flush text composed against the OLD bytes under a validator for
  the NEW ones and the server would accept it. `conflictedDrafts` names exactly
  those files and the editor banners them; saving still writes the author's
  version — an informed overwrite, never a silent one. The server stays the only truth for
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
- `mutatePackageDraftFiles(target, input)` — the one read-modify-write for a
  package's draft tree. `input` is `{ precondition, mutate }` plus an optional
  `manifest` and `draftContent`, which default to the row's current values;
  there is no `label` and no per-call manifest-storage option.
  1. `db.transaction`: advisory lock on the package id;
  2. the row (`draft_manifest`, `draft_content`, `lock_version`), then
     `readPackageSnapshot(source, draft)` — the overlaid tree, so a fresh
     package with no ZIP still yields its `SKILL.md` + `manifest.json`;
  3. check `precondition` — `{ etag }` against `indexEtag(snapshot.snapshotId)`
     → `412`, or `{ lockVersion }` against the row → `409` (the `PUT`'s
     contract, unchanged);
  4. `mutate(files)` → new map; `assertArchiveContentConforms(type, files,
"file")` on the bytes about to be STORED; caps;
  5. row update through `updateOrgItem`: `lock_version + 1`, `updated_at`,
     `draft_manifest`, and `draft_content` = the decoded content entry unless
     the caller resolved it. Losing the optimistic-lock race here → `409`;
  6. upload: `manifest.json` is stripped when the TYPE does not store it
     (`CONFIG_BY_TYPE.manifestIsStoredFile` — `false` for `agent` / `skill`,
     where the overlay re-adds it from `draft_manifest`; `true` for
     `integration` / `mcp-server`, whose archive holds it like any other file),
     then `uploadPackageFiles(folder, orgId, id, files)`;
  7. return `{ snapshot, lockVersion }`.

  The row is written BEFORE the object, and the upload runs INSIDE the
  transaction: an upload that fails — the likelier of the two, being a network
  round-trip — rolls the row back with it and the write simply did not happen.
  What remains is a successful upload followed by a failed COMMIT. The overlay
  then hides exactly the two entries it owns, the content entry and
  `manifest.json`, read back at their pre-write values; every OTHER entry of the
  batch DID land — an ancillary file written is listed, one deleted is gone, one
  moved sits at its new path — while `lock_version` did not move and nothing
  told the caller. The helper's header states it; closing it means storing each
  write as a content-addressed object and swapping a pointer, a storage layout
  this package does not have.

- The other EDITING writers take the same helper: the package `PUT`
  (`makeUpdateHandler`) replaces its `downloadPackageFiles …
uploadPackageFiles` tail with it (`precondition: { lockVersion:
body.lock_version }`, `mutate` = set the content entry), and so does a version
  restore — a whole-tree replacement, one write rather than two, so a `PATCH`
  taking the lock runs strictly before or strictly after it.
  `postInstallPackage` does NOT, for the two reasons its own header states: the
  content gate is deliberately not applied to a bundle's non-root packages (AFPS
  §3.3 gates the ROOT only), and that path persists a raw manifest into the
  version while the draft row takes a normalized one — one write cannot do both.

### 4.3 Route — `routes/packages.ts`

```
PATCH /api/packages/:scope/:name/files
  rateLimit(30) → assertPackageMutationAccess(write)   // row + <type>:write in
                                                       // every install space
                                                       // + system 403
  → CONFIG_BY_TYPE[type].draftFilesWritable || 400
  → If-Match required (428) → readJsonBody(patchPackageFilesSchema)
  → mutatePackageDraftFiles → 200 { entries, lock_version } + ETag + fileCacheHeaders
  → recordAuditFromContext("package.updated", { type, fileOperations, filePaths })
```

The authority gate is FIRST: it settles before the `428` and before the body is
read, so a caller who may not write the package learns nothing from the
validator requirement, from a body-shape rejection, or from the type gate.

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

- `file-tree.tsx` — `FileTree` with an optional `actions` prop, replacing
  `ReadOnlyFileTree` rather than forking it: row context actions (rename,
  delete) and a header toolbar (new file, upload), absent when `actions` is.
  The pure keyboard/ARIA model is unchanged; `F2` = rename, `Delete` = delete,
  both no-ops on the pinned entry. Folders stay implicit (a path with `/`), as
  in the index.
- `package-files-editor.tsx` — owns: the `GET …/files` query and the `ETag`
  from its headers (`use-package-draft-files.ts`: one mutation, `If-Match` from
  the last index, replaces the query cache with the response), the selected
  path, and the `lock_version` it lifts to the parent. The dirty map itself
  lives one level up, beside the manifest, because the two together are what
  "unsaved changes" means; the component exposes `flush()` and
  `contentEntryText()` to the save bar through `useImperativeHandle`. Right
  pane: `ContentEditor` for text (`languageForPath`), the existing
  `FilePreview` metadata card + _Remplacer_ / _Supprimer_ for binary or
  oversized. Dialogs: one `file-path-dialog.tsx` (`FilePathDialog`, live path
  validation) serves create AND rename — one path input, one rule set — plus
  `ConfirmModal` for delete. Upload = `<input type=file multiple>` → base64
  `write` ops, client-side 1 MiB check with the same message the server would
  give. `ContentEditor` is uncontrolled after mount (`defaultValue`, remounted
  by `key` when the text must change from outside): a controlled `value` drops
  keystrokes typed within one React batch — the reason is in the header of
  `content-editor.tsx`.
- `PackageEditorInner` (`pages/package-editor.tsx`): the `content` tab becomes
  `files` and mounts `PackageFilesEditor`; on an existing skill `SKILL.md` is a
  file like the others and the `PUT` body carries the manifest alone. Save =
  `flush()` then the manifest `PUT` with the `lock_version` the flush returned —
  sent even when the manifest is clean, because that mutation owns the
  post-save cache invalidation and the navigation back to the detail page.
  `validate` keeps the frontmatter check on the content entry as the editor
  holds it (already the same checker the routes run).
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
- e2e `e2e/tests/agents/skill-files-editor.ui.spec.ts` (label `e2e`), six
  scenarios: adding a file, buffering its text until save, and the API index
  holding both; renaming and deleting without a save; no rename or delete
  affordance on `SKILL.md` or `manifest.json`; a write composed against a tree
  that moved refused and the index re-read; a file the `412` recovery re-read
  under an open buffer marked and saved anyway; leaving the page blocked while
  a file edit is still buffered.

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

Shipped as 11 commits; two adversarial reviews and CI added the authority
gate, the collision rules, the Monaco fix and the plan corrections above.

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
