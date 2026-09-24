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

## [0.9.1] — unreleased

Additive only. `@appstrate/core` declares `^0.9.1`, so tag `afps-shared@0.9.1`
on the squash commit right after merge (`docs/deployment/RELEASING_CORE.md` §1).

### Added

- **`credentialTemplateRefs`** and **`renderAuthorizedUris`**
  (`./credential-template`) — the field names a `{$credential.<field>}`
  template references (in order, deduplicated), and the per-connection render
  of `authorized_uris`: an untemplated pattern passes unchanged; a templated
  one is dropped when any referenced field is missing, empty, outside
  `[A-Za-z0-9.-]` or made only of dots, so a value cannot add a wildcard, a
  separator or another host (`@appstrate/core` confines placeholders to the
  host and port). An empty result means deny-all.

## [0.9.0]

Not additive: `normaliseMcpToolBody` changes behaviour (see Changed), which the
0.x convention makes a minor bump.

### Added

- **`./jsonpath`** — `parseJsonPath`, `evaluateJsonPath` and
  `JsonPathSyntaxError`: the one JSONPath dialect of integration manifests,
  moved out of `@appstrate/connect`'s login engine so `identity_claims` reads
  paths with the same evaluator. The single-value RFC 9535 subset `$`,
  `.name` (member-name-shorthand: a letter, `_` or non-ASCII character, then
  also digits), `['name']` / `["name"]` (RFC 9535 string literals and escapes),
  `[0]` / `[-1]` (RFC 9535 `int`: no leading zero, no `-0`; negative counts
  from the end). A path outside it throws `JsonPathSyntaxError` with the
  offset — including a union (`['a','b']`), a wildcard, a filter, a slice and a
  `.name` starting with a digit (write `[0]`); a valid path that selects nothing
  returns `undefined`. A member selects only an object's own property, an index
  only an array element.

- **`isValidMcpToolName`**, **`allocateMcpToolName`** and **`fnv1a64Hex`**
  (`./mcp-naming`) — the exposed-name grammar (`{namespace}__{body}`, body in
  `[A-Za-z0-9_-]+`, at most `MCP_TOOL_NAME_MAX_LENGTH`), the allocator that
  truncates and hash-suffixes a name that is too long or taken (one salted
  re-hash when the hashed name is taken too, then it throws), and the digest
  it uses. When two upstream names normalise to the same body, the first one
  registered keeps the plain name.

### Changed

- **BREAKING: `normaliseMcpToolBody`** (`./mcp-naming`) maps only the
  characters LLM providers reject in a tool name to `_`, one per code point.
  It no longer lowercases, collapses runs, trims underscores or drops an
  upstream `ns__` prefix (`drive__api.upload` now yields `drive__api_upload`,
  not `api_upload`).

## [0.8.0] — 2026-09-03

Additive only: no existing export changes behaviour, so a 0.7.0 consumer that
upgrades and calls nothing new sees no difference. The minor bump is the 0.x
convention for new API, not a break.

### Added

- **`checkSkillMarkdown(content)`** (`./companion-files`) — the PRODUCER-side
  AFPS §3.3 gate. Returns the first violation of: frontmatter `name` present →
  `name` conforming to the [Agent Skills
  specification](https://agentskills.io/specification) (1-64 code points of
  lowercase `a-z`, `0-9` and `-`, no leading, trailing or consecutive hyphen) →
  `description` present → `description` at most 1024 code points. Three new
  `CompanionViolationReason` values carry the new outcomes:
  `SKILL_INVALID_FRONTMATTER_NAME`, `SKILL_MISSING_FRONTMATTER_DESCRIPTION`,
  `SKILL_INVALID_FRONTMATTER_DESCRIPTION`.

  **It is deliberately NOT part of `checkCompanionFiles`, whose behaviour is
  byte-for-byte unchanged** — including its private `hasFrontmatterName` probe,
  which is NOT routed through the new parser. That function also runs on the
  LOADER side, over already-published immutable bundles, and published
  artifacts exist whose frontmatter `yaml` cannot parse at all: 17 skills in
  production carry an unquoted `description: … : …`, which `yaml` refuses with
  "Nested mappings are not allowed in compact mappings". Routing the loader
  through the parser would stop every run of every agent depending on one of
  them, for a defect nobody can fix in an immutable artifact. Its acceptance
  set may therefore never shrink. Callers that WRITE skill content call
  `checkSkillMarkdown`; callers that LOAD a bundle keep calling
  `checkCompanionFiles`.

  **Containment: what the gate accepts is a SUBSET of what the loader
  accepts.** Each reading accepts documents the other refuses — `name:\n  triage`
  and `name : triage` are valid YAML the loader's substring probe cannot see,
  and accepting them would mint an IMMUTABLE version the run launcher then
  refuses to load. So `checkSkillMarkdown` ends by requiring `hasFrontmatterName`
  to agree, answering `SKILL_INVALID_FRONTMATTER_NAME` with `name must be
written inline on one line` when it does not. A table test asserts the
  invariant over every accepted form.

- **`parseSkillFrontmatter`** (`./companion-files`) — the one `SKILL.md`
  frontmatter reader. Returns `{ found, unterminated, error, name, description }`.
  `@appstrate/core`'s `extractSkillMeta` now reads through it rather than
  keeping a second copy of the same regexes, so the gate and the metadata the
  platform stores can no longer disagree about what a `SKILL.md` declares.

  **It parses with the `yaml` library (a new dependency, `^2.9.0`), because
  that is what the consumer does.** The runtime that loads a skill —
  `@earendil-works/pi-coding-agent`, `dist/utils/frontmatter.js` — normalises
  newlines, requires a leading `---`, cuts the block at the first `\n---` and
  hands the slice to `yaml`'s `parse`. This function mirrors that against the
  same library at the same major, so the gate cannot accept a document the
  consumer then fails to read. `uniqueKeys` and `strict` are passed explicitly
  so a future default change cannot loosen the gate in silence.

  A leading BOM is NOT stripped, because the runtime does not strip it either:
  Pi tests `startsWith("---")`, reads no frontmatter behind a byte-order mark
  and drops the skill. `checkSkillMarkdown` answers `SKILL_INVALID_FRONTMATTER`
  naming the BOM rather than rewriting the author's bytes. The companion export
  **`decodeSkillMarkdown(bytes)`** exists for the same reason: a default
  `TextDecoder` silently eats a BOM, so every write path that starts from
  stored or archived bytes decodes through it (`ignoreBOM: true`).

  Parity is exact for PARSING, not for the rules: Pi only WARNS on a spec
  violation and measures the description in UTF-16 units, while the bounds here
  follow the spec (characters, hence code points). The asymmetry is
  one-directional by design — stricter than the consumer, never looser.

- **`SKILL_INVALID_FRONTMATTER`** — a fifth `CompanionViolationReason`, for a
  block that cannot be read as `{ name, description }` at all: a YAML syntax
  error, a non-mapping document, a duplicate key, or a non-string field. The
  library's own message is included (`frontmatter is not valid YAML: …`). An
  empty or explicitly-null scalar is NOT this — `description:` and
  `description: null` both mean "not provided" and keep answering
  `SKILL_MISSING_FRONTMATTER_DESCRIPTION`.

- **`isValidSkillName`**, **`SKILL_NAME_MAX_LENGTH`** (`64`),
  **`SKILL_DESCRIPTION_MAX_LENGTH`** (`1024`) and the **`SkillFrontmatter`**
  type (`./companion-files`) — the naming rule and its bounds, exported so a
  caller can pre-validate a name instead of restating the regex. Both bounds
  count Unicode CODE POINTS, not UTF-16 units. This is a different namespace
  from a package id (`@scope/name` under `SLUG_PATTERN`, unbounded and
  `--`-tolerant): neither validator may be substituted for the other.

## [0.7.0]

`@appstrate/core` declared `^0.7.0` at HEAD; published as
`afps-shared@0.7.0`.

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
