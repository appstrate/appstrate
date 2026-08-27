# Changelog

All notable changes to `@appstrate/afps-shared` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This package is `0.x`, so the MINOR position carries breaking changes: a
consumer's `^0.6.0` does not accept `0.7.0`. Every consumer range must be
raised by hand, and this package must reach npm BEFORE any release of a
consumer that raises its range — `scripts/verify-package-resolves.ts` installs
the real tarball outside the monorepo, so an unpublished leaf fails the
consumer's publish rather than the first user's `npm install`.

## [0.7.0] — unreleased

Not yet on npm. `@appstrate/core` already declares `^0.7.0` at HEAD, so
**this version must be published (`git tag afps-shared@0.7.0`) before the next
`@appstrate/core` release**, and `bun scripts/verify-package-resolves.ts
packages/core` stays red until it is.

### Added

- **`DEFAULT_MAX_REDIRECTS`** (`./guarded-fetch`) — `10`, the default of
  `guardedFetch`'s `maxRedirects` and the single redirect budget in the
  codebase. It replaces two unrelated numbers that did the same job with no
  knowledge of each other: `maxRedirects ?? 5` here, and a hard-coded
  `MAX_REDIRECTS = 10` in `@appstrate/afps-runtime`'s credential-proxy
  follower.

- **`isMultipleFileField`** (`./file-field`) — an array whose `items` are a
  single file node. Derived from the same private single-file-node predicate as
  `isFileField`, so the two cannot disagree about the same array node.
  `@appstrate/core/form` carries a parallel copy of both rules and will be able
  to import them instead once this version is on npm and core's floor has
  moved — the reason the copy exists is that published `0.6.0` exports only
  `isFileField` from this subpath.

### Changed

- **`guardedFetch`'s default `maxRedirects` is 10, not 5** (`./guarded-fetch`).
  10 is the value with a reason: the credential proxy walks multi-step
  OAuth/CAS dances whose session cookie lands on an intermediate 302 (#473),
  and five hops does not always reach the end of one. Nothing is weakened by
  the raise — every hop is independently DNS-checked, allowlist-checked and
  credential-stripped, so the cap is a loop/DoS bound and not a trust
  boundary. Callers that want the old ceiling pass `maxRedirects: 5`.

- **`guardedFetch` follows the WHATWG 301/302 method rule**
  (`./guarded-fetch`) — a behaviour change, which is why this is a minor and
  not a patch. The downgrade clause read
  `(301 | 302) && method !== "HEAD" → GET`, so a 302'd `PUT`/`PATCH`/`DELETE`
  was re-issued as a bodyless `GET`: a request the caller never made, silently.
  WHATWG fetch (HTTP-redirect fetch step 11) and RFC 9110 §15.4.3 downgrade
  **POST only**; 303 still downgrades everything except GET/HEAD, and 307/308
  still preserve method and body. `GET` and `POST` callers — every current one
  in this repo — are unaffected. `@appstrate/afps-runtime`'s credential-proxy
  follower always had the conformant rule; this side did not, and the two
  disagreed about the same response.

- **`isFileField`** (`./file-field`) accepts an `unknown` node structurally,
  as before, and is now expressed as
  `isSingleFileNode(schema) || isMultipleFileField(schema)`. Every verdict is
  unchanged — `packages/core/test/form.test.ts` pins the whole table.

### Not exported, on purpose

- `isSingleFileNode`, `resolveItems` and `resolveType` are shared
  implementation detail of the two `./file-field` predicates and stay private.
  Exporting a name from this package is a semver commitment to out-of-tree
  consumers; these have no importer, and the module's own header argues that
  `@appstrate/core` must not reach for them.

## [0.6.0] and earlier

Not recorded here — this file starts at 0.7.0. `git log packages/afps-shared`
is the history for anything older.
