# Unified package draft editor

Implementation in PR #1312. This replaces the original skill-only design.

## Contract

Agents, skills, integrations and MCP servers have the same Files editor. Every
file gesture is staged in the local package draft: creation, typing, uploads,
replacement, rename and deletion. Save and the unsaved-navigation dialog use
one request to the existing `PUT /api/packages/{type}/{scope}/{name}` with
`manifest`, optional ordered `operations` and the original `lock_version`.
The existing `content` request field remains supported for API clients.

The draft owns its manifest and pending file operations. The file tree is a
projection of its initial index plus those operations; it cannot acquire a
fresh write token from an independent file request. A concurrent change rejects
the entire save with 409 and retains the local draft. The author can copy their
changes and reload explicitly. Controls lock during file reading and saving.
There is no automatic overwrite, autosave, merge engine or second write route.
Import refuses an entire selection if any path collides with the current
draft or another selected file. The explicit Replace action is available for
both text and binary files. Deletion confirmations describe the deferred save,
and path errors are associated with their input for assistive technology.

## Shared implementation

- `@appstrate/core/package-file-operations` applies the same ordered operations
  to browser entries and server bytes. It checks archive paths, move targets,
  protected entries and case/NFC collisions, including directory ancestors.
- `useEditorState` owns the draft, its original token and its save lifecycle.
  `PackageFilesEditor` stages operations and uses the existing file tree,
  Monaco editor and read API for all four types.
- `mutatePackageDraftFiles` serializes draft saves, restores and imports through
  an advisory transaction lock, then updates the package row and draft ZIP.
  Imports preserve their original immutable version bytes and manifest.
- Publication captures its package row and stored ZIP under the same draft lock,
  releases it, then validates and publishes that immutable capture. A version
  override updates the draft only after a successful publication, and only if
  its original lock token still matches; that update increments the token without
  marking already-published changes as dirty. A newer edit stays unpublished even
  if it completed before the captured version was created.

`manifest.json` is edited through the manifest form/JSON tab. Skills require
valid frontmatter in `SKILL.md`; agents require `prompt.md`. Required content
cannot be empty, deleted or renamed. `INTEGRATION.md` is optional and removable.
Executable file edits run bundle validation, so moving an MCP entry point
requires updating its manifest in the same save. Manifest-only draft saves
retain the existing ability to be incomplete until publication.

## Boundaries and limits

Writes retain the existing package mutation authority, including write access
in every space sharing the draft, and refuse system packages. Reads remain
permission checked and use representation-specific ETags only for caching.

A batch accepts at most 200 operations, 1 MiB per written file, and a resulting
tree of at most 50 MB / 10,000 entries. The global HTTP body limit also applies.
Larger binaries can be imported in an archive. Binary content is never decoded
and re-encoded for storage; staged binaries have no server download until saved.
Buffered S3 GET/PUT operations have a 30-second deadline spanning retries and
the complete response body. Expiration aborts the request and cancels the body
reader, so stalled storage cannot retain a transaction indefinitely. Streaming
transfers keep their existing lifetime.

PostgreSQL and object storage do not share a transaction. Upload failures roll
back the row; an upload followed by a failed DB commit can still leave ancillary
ZIP bytes ahead of the row. The shared lock prevents writers from interleaving;
it does not claim distributed atomicity. No schema migration is introduced.

## Validation

Integration tests cover the four package types, combined metadata/file saves,
conflicting and concurrent tokens, authorization, imports, restores, executable
references, optional companions, byte limits and unchanged state on rejection.
Publication tests interleave validation with a draft edit, exercise the actual
PostgreSQL advisory lock, and cover version override rejection, stale tokens and
unpublished-change detection. S3 tests simulate stalled PUT responses, GET headers
and response bodies, and verify both
connection cancellation and recovery on the next request.
Pure tests exercise ordered operations and canonical path collisions. Browser
tests exercise real saves, local staging, navigation guards, conflicts and
controls while saving, import collisions, explicit replacement and accessible
path errors, including the narrow layout.
