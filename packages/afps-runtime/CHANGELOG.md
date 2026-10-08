# Changelog

All notable changes to `@appstrate/afps-runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — a sticky cookie expires (#1778)

- `CookieScope.capture` keeps each cookie's expiry: `Max-Age` (capped at
  400 days, RFC 6265bis §5.6.2, so it stays finite through JSON), else
  `Expires` (RFC 6265 §5.2.1–5.2.2), as an absolute time from the receipt
  time. `header` never sends an expired cookie, so an expired same-name
  cookie no longer masks the injected credential; expired entries are purged
  from a bucket at its next capture. A cookie with neither attribute lives as
  long as the jar. Before, only `Max-Age <= 0` or a past `Expires` was
  honoured, at capture, and any other cookie was replayed indefinitely.

### Changed — `CookieJar` stores each cookie's expiry (#1778, BREAKING)

- `CookieJar` is `Map<string, { pair: string; expiresAt?: number }[]>`
  (`expiresAt` in epoch ms), no longer `Map<string, string[]>`.
- `CookieScope.capture` takes an optional `now` (the receipt time, default
  the current time).

### Changed — no longer published to npm

- The package is `"private": true`: it is not published to npm. It is
  consumed in-tree, by the platform through `workspace:*` and by `apps/cli`,
  which bundles it into the `appstrate` binary.

### Added — one preparation of the caller half of an api_call (#1660)

- `prepareApiCallRequest({ target, headers, bodyTemplates, fields })` and
  `PreparedApiCallRequest` (`./resolvers`): the target and the caller's
  headers substituted, the headers a credential went into, and every
  template of the call for `credentialUrlPolicy`; or the first defect,
  worded (an unresolved placeholder in the target, a header or the body; a
  header value that is no HTTP field value). It repairs `Bearer{{field}}` on
  the template of `Authorization`.

### Changed — local resolver (#1660)

- It goes through `prepareApiCallRequest`: it repairs `Bearer{{field}}`,
  names the first unresolved location
  (`Unresolved placeholders in target: {{a}}`) where it listed every key,
  and judges a caller header value as written, first
  (`RESOLVER_HEADER_INVALID`): ahead of the URL policy, of an unresolved
  placeholder elsewhere and of a body error, and for a header the resolver
  then replaces.

### Changed — one outbound engine for every api_call path (#1641)

- **BREAKING:** `guardedFetch`, `fetchFollowingRedirectsCapturingCookies`,
  `MAX_REDIRECTS`, `matchesAuthorizedUri`, `stripUserInfoAndFragment`,
  `scrubTransportError`, `redactHost` and `RedirectBlockedError` are no longer
  exported; `fetchApiCall` replaces the first two. By default it pins every
  hop to its DNS-validated address. It bounds the call with
  `API_CALL_TIMEOUT_MS` combined with the caller's signal, keeps the
  credential across a redirect only to an origin the allowlist names (never
  https→http), and refuses every target when there is no allowlist and no
  `allow_all_uris`. `internalHost` is required: a host skips the SSRF gate
  only when it accepts the host AND the declared allowlist names that host
  literally, never under `allow_all_uris` (#1657). There is no default: each
  caller says who owns the network the call leaves from.
  It forwards only end-to-end caller headers: a caller's `Host`, the
  hop-by-hop headers (and any header `Connection` names, except a credential
  header) and `Content-Length` are dropped.
- New exports: `fetchApiCall`, whose messages name the initial target by
  `targetHost` (required: its host as the template names it, `templateHost`,
  also new) and which scrubs `credentialFields` (required: `{}` scrubs
  nothing) from redirect hosts and transport errors only; its optional
  `bodyLength` is a `ReadableStream` body's trusted size, sent as its
  `Content-Length` (omitted: chunked). It throws `InvalidHeaderValueError`
  (`@appstrate/afps-shared`) on a header value that is no HTTP field value,
  a `Headers` instance's included, before anything is sent. Also
  `API_CALL_TIMEOUT_MS`, `HOP_BY_HOP_HEADERS` (its one home: the
  `@appstrate/connect/proxy-primitives` and sidecar re-exports are gone),
  `unresolvedPlaceholders` (the `{{key}}` placeholders of a template that its
  fields do not own, read on the template, never on the substituted string)
  and `classifyApiCallFailure`: what `fetchApiCall` threw, as
  `not_authorized`, `ssrf`, `unresolvable`, `invalid_header`, `timeout` or
  `transport`, flagged when a redirect hop was refused. A target or a
  redirect hop with no DNS answer is `unresolvable` (a 502 on both proxies).
  Both resolvers raise `RESOLVER_HEADER_INVALID` on an agent header that is
  no HTTP field value; `RemoteAppstrateIntegrationResolver` applies the same
  caller-header rule to the agent's headers, its transport headers and
  `Content-Length` always its own.
  `LocalIntegrationResolver` refuses a call whose target, header or string
  body names a `{{field}}` its credentials do not hold
  (`RESOLVER_BODY_INVALID`); it was rendered empty. `ApiCallMeta` is
  `{ name }`: `makeApiCallTool` gates nothing, the allowlist is
  `fetchApiCall`'s. `ApiCallFailureClass` and `HostResolver` (import it from
  `@appstrate/afps-shared/ssrf-dns`) are not exported.
- **BREAKING:** `matchesAuthorizedUriSpec`, `compileEgressPolicy` and
  `hostLiterallyAllowlisted` read each entry through
  `parseAuthorizedUriPattern` (`@appstrate/afps-shared/credential-template`),
  the parser the host-bound rule judges. A malformed entry (an authority that
  is empty, not spelled as WHATWG serialises it, or holding `%`, `\`, `@`,
  `?`, `#`, whitespace, a control or non-ASCII character) matches no URL,
  grants no authority and pins no host.
- **BREAKING:** a call that carries a credential — substituted or injected by
  the proxy — drops `allow_all_uris`, and `credentialUrlPolicy` refuses it
  when `authorized_uris` is empty or an entry leaves the host to the caller
  (below).
- **BREAKING:** `resolveHttpDelivery` renders `valueFrom.template` with
  `renderCredentialTemplate`: `{$credential.<field>}` only, and any other
  `{$…}` in a delivery value throws.

### Changed — `authorized_uris` rendered per connection; only declared hosts pin (#1627)

- `fetchApiCall` takes a required `declaredUris`: the manifest's declared,
  unrendered `authorized_uris`. `authorizedUris` (the list rendered for the
  connection) decides what matches; only a host written literally in
  `declaredUris` exempts a target from the SSRF net, and only those hosts
  share cookies across origins. `hostLiterallyAllowlisted` never pins a
  templated host (`{…}`).
- `LocalIntegrationResolver` renders each auth's `authorized_uris` with the
  creds file's fields (`renderAuthorizedUris`,
  `@appstrate/afps-shared/credential-template`) and enforces it on the
  substituted target, so `{{site_url}}/wp-json/…` matches a
  `{$credential.site_url}/**` entry. The `api_call` schema accepts a target
  that starts with a `{{field}}` followed by nothing or a `/` path;
  `apiCallRequestJsonSchema` publishes it (`anyOf` a `uri` or that pattern),
  and the new `apiCallTargetJsonSchema` export is its `target` property for
  tool schemas composed by hand.
- A declared allowlist that renders to nothing for the connection (its URL
  field unset or not an absolute http(s) URL) refuses every target:
  `credentialUrlPolicy`'s `"unrendered"` refusal, on the local resolver, the
  sidecar and the platform proxy.
- Off-allowlist refusals (`fetchApiCall` and the `api_call` tool's allowlist
  check) name the DECLARED entries, never a rendered one — an exact-URL entry
  such as `{$credential.webhook_url}` renders to a secret.

### Changed — `X-Run-Id` is a reserved transport header

- An `api_call`'s own `x-run-id` header (any casing) is now dropped, like the
  other Appstrate transport headers: the remote resolver sets `X-Run-Id` itself
  (`extraHeaders`), and a second casing would reach the platform merged as
  `"a, b"`. `X-Connection-Id` stays open, only so that a caller already holding
  a connection id can name it: the `api_call` tool has no argument addressing
  one member of a bound set, which is why the platform refuses a remote run
  that binds several connections to one integration.

### Added — `readIntegrationManifest`

- `readIntegrationManifest(bundle, ref)`, exported from
  `@appstrate/afps-runtime/resolvers`: the integration manifest a ref resolves
  to in the bundle, unvalidated — its `integration.json` (else `manifest.json`)
  file, else the package's parsed manifest; `undefined` when the bundle does
  not carry the package. `readApiCallIntegrationMetas` now reads through it.
  `@appstrate/runner-pi` uses it to expose `api_call` only for the tools the
  agent selected.

### Added — the pre-send URL policy of the three `api_call` paths

Exported from `@appstrate/afps-runtime/resolvers` and shared by the sidecar,
the local resolver and the platform credential proxy:

- `credentialUrlPolicy(input)` — `templates`, `fields`, `allowAllUris`,
  `declaredUris`, `authorizedUris`, `injectsCredential` — returns a
  `CredentialUrlPolicy` (`substitutesCredential`, `allowAllUris`, `refuse`).
  A call whose
  `templates` reference a credential field, or whose credential the proxy
  injects, loses `allow_all_uris`. `refuse` (`UrlPolicyRefusal`) is
  `"unrendered"` when the declared allowlist renders to nothing for the
  connection, `"exfiltration"` when a credential-carrying call has no
  allowlist or an entry that leaves the host to the caller, `"unauthorized"`
  when there is no allowlist and no `allow_all_uris` (an empty authorized set
  authorizes nothing), otherwise `null`. `templates` must be exactly the
  strings substituted — the sidecar passes a JSON body's string leaves, not
  `JSON.stringify(body)`, whose escaping hid `{{\tapi_key}}`.
- `urlPolicyRefusalMessage(refusal, integrationId)`: the one message per
  refusal; it names no credential value.
- `redactionFields(policy, fields)`: the credential values to scrub from an
  echoed host — `fields` when the call templates a credential, `{}` otherwise.
- `redactCredentialHost(url, fields)`: the URL's host with credential values
  (compared lowercased) replaced by their `{{field}}` placeholder.
- `fetchApiCall` scrubs its `credentialFields` from every host its refusals
  and logs name; a transport error on a templated call keeps only its
  message, every URL cut to its redacted host (Bun keeps the full URL on
  `.path`). The "Too many redirects" error names the start URL's host
  instead of the full URL.

### Changed — local resolver

- Runs the shared policy: an `"exfiltration"` refusal is
  `RESOLVER_CREDENTIAL_EXFIL_BLOCKED`, an `"unrendered"` or `"unauthorized"`
  one `AUTHORIZED_URIS_EMPTY`, both with `urlPolicyRefusalMessage`'s message.
- A refused target's error `details.target` carries the template
  (`https://{{api_key}}.x.com/`), never the substituted URL, and the host in
  the message has credential values scrubbed.

### Fixed — own-property placeholders

- `substituteVars` and the guard's placeholder lookup match own properties
  only: `{{constructor}}` no longer resolves to `Object.prototype`'s.

### Changed — the redirect follower takes a `CookieScope` (BREAKING)

- `fetchApiCall` takes `cookies: CookieScope` (omitted: a jar living for the
  call's redirect chain only) where the follower it replaces took a
  `cookieJar` map. Each hop's `Set-Cookie` lands in the bucket of
  THAT hop's origin (host-only), no longer in the initial target's, and every
  hop's `Cookie` (the first included) is composed from `init`'s uncomposed
  `Cookie`. Once a cross-origin credential strip fires, that `Cookie` is
  dropped for the rest of the chain.
- Cookies are host-only: `Domain` is ignored, so a cookie
  `id.vendor.example` sets with `Domain=vendor.example` is not replayed to
  `www.vendor.example` unless both hosts are literal `authorized_uris`
  entries — list both to share it (honouring `Domain` safely would need the
  Public Suffix List).
- `Path` is ignored too: a same-name cookie scoped to another path shadows
  the injected one on every path of that origin. Each origin bucket keeps at
  most 50 cookies, evicting the least recently set names first.
- `mergeSetCookieIntoJar` is no longer exported: `CookieScope.capture`
  replaces it.
- New `cookieScope(jar, integrationId, literalAllowlist)`, `CookieScope` and
  `CookieJar`, exported from `@appstrate/afps-runtime/resolvers`, shared by
  both credential proxies. `header(url, base)` composes one `Cookie` header:
  sibling literal-allowlist origins < `base` (injected credential / caller
  cookies) < the URL's own origin. `capture(url, setCookies)` strips
  attributes and removes a cookie expired by `Max-Age <= 0` or a past
  `Expires`.
- `hostLiterallyAllowlisted` now lives in `http-call-core.ts`; still exported
  from `@appstrate/afps-runtime/resolvers`.

### Removed — `computeTokenCost` (BREAKING)

- `computeTokenCost` is no longer exported from `@appstrate/afps-runtime/runner`.
  The platform prices token usage with Pi's `calculateCost`, which honours the
  model's price tiers. `classifyTokenPricing` and `TokenCost` stay.

### Added — runner egress policy

- `compileEgressPolicy({ authorizedUris, allowAllUris })` and the
  `EgressPolicy` type, exported from `@appstrate/afps-runtime/resolvers`.
  `allowsUrl(url)` applies the `matchesAuthorizedUriSpec` grammar to every
  pattern; `allowsAuthority(host, port)` projects `scheme://` patterns onto
  host + port (explicit port, else the scheme default: https/wss 443,
  http/ws 80, ssh/sftp 22). Scheme-less patterns, unknown schemes without a
  port, IPv6 hosts and invalid ports grant nothing. A host wildcard never
  spans the port: `https://*/**` grants port 443 only; any other port must be
  written (`:8443`, or `:*` for any).

### Changed — tool-result cap is a parameter, not an env read (BREAKING)

- `truncateToolResult(result, limitBytes)` no longer reads
  `TOOL_RESULT_BYTE_LIMIT`; its default is the exported
  `DEFAULT_TOOL_RESULT_BYTE_LIMIT` (2048). `toolResultByteLimit()` is removed:
  the embedding process parses its own env and passes the cap in.

### Changed — `EventSink.finalize` takes a `TerminalRunResult` (BREAKING)

- New `TerminalRunResult` (a `RunResult` whose `status` is required) and
  `RunTerminalStatus` types, exported from `@appstrate/afps-runtime/runner` and
  `/types`. `EventSink.finalize`, `HttpSink`, `CompositeSink`, the reducer sink
  and `mergeTerminalResult` now take it: a runner must stamp the terminal
  status before finalizing. The platform's finalize endpoint no longer infers
  a missing status from `error`, and it requires `usage` when the status is
  `success`.
- `finalizeThrownFailure` always stamps a status. The `setFailedStatus` option
  is removed; `terminalStatus` (default `"failed"`) is narrowed to the
  non-success statuses.
- `mergeTerminalResult` carries every terminal field of the runner's result,
  `artifacts` included — it used to drop it.

### Removed — five unraised error classes and the `isAfpsError` marker

- `RunTimeoutError`, `RunCancelledError`, `WorkloadExitError`,
  `RunHistoryError` and `CredentialResolutionError` are gone from
  `@appstrate/afps-runtime/errors`, along with their codes (`RUN_TIMEOUT`,
  `RUN_CANCELLED`, `WORKLOAD_EXIT_NONZERO`, `RUN_HISTORY_FETCH_FAILED`,
  `RUN_HISTORY_BAD_RESPONSE`, `CREDENTIAL_RESOLUTION`) in the `AfpsErrorCode`
  union, and the `isAfpsError` marker predicate. Nothing in this package or in
  the platform ever raised one: the taxonomy was written ahead of the call
  sites, and the call sites were built on other error paths. Timeouts,
  cancellation and non-zero workload exits are decided by the runner
  (`PiRunner.readTerminalError`) and surfaced as run status, not thrown as
  typed errors; run-history failures and credential resolution raise
  `ResolverError`. `isAfpsError` existed to branch across the deleted set — the
  two classes that remain, `ResolverError` and `AuthorizedUrisError`, are
  reached by `instanceof` at every live call site.
- `AfpsError` remains exported as the structural shape (`name`, `code`,
  `message`, optional `details`), and `AfpsRuntimeError` remains the base
  class. No live import changes.

### Changed — the two surviving error classes can carry a `cause`

- `AuthorizedUrisError` and `ResolverError` gained an optional trailing
  `options?: ErrorOptions` argument, forwarded to `AfpsRuntimeError`'s base
  constructor. Until now the base accepted `ErrorOptions` and neither concrete
  class passed one, so the parameter was unreachable and the runtime's own
  errors could not participate in a `cause` chain — in the same cycle that
  threaded `cause` through the rest of the platform. Purely additive: every
  existing call site keeps its meaning.

### Removed — four unread re-exports from the resolvers barrel

- `defaultInlineLimit`, `isReproducibleBody`, `resolveBodyForFetch` and
  `serializeFetchResponse` no longer appear in
  `@appstrate/afps-runtime/resolvers`. The three that still have a consumer are
  reached by their own module path from `integration-api-call.ts`;
  `defaultInlineLimit` is now private to `http-call-core.ts`. Barrel-only
  removal — the implementations are unchanged.

### Removed — the `Runner` interface

- `Runner` (`{ name, run(options: RunOptions): Promise<void> }`) is gone from
  `@appstrate/afps-runtime/runner`. It had exactly one implementation and no
  consumer anywhere typed against it — every caller constructs its concrete
  runner directly — so it named a polymorphism nothing exercised, and the
  single-engine decision means no second adapter is coming. `RunOptions`, the
  argument shape a runner is actually handed, stays exported and unchanged: it
  is what a downstream runner conforms to.

### Removed — the `dataschema` attribute

- CloudEvent envelopes no longer carry the OPTIONAL `dataschema` attribute
  (CloudEvents 1.0 §3.1), and `canonicalEventSchemaUri` /
  `CANONICAL_EVENT_SCHEMAS` / `CANONICAL_EVENT_SCHEMA_VERSION` are gone from
  `@appstrate/afps-runtime/events`.

  The URIs it carried were never served — `schemas.afps.dev/v0/events/*` 404s
  and `schemas.appstrate.dev` has no DNS record — but that was the smaller
  problem. AFPS defines `RunEvent` with an OPEN payload: the specification
  reserves event _namespaces_ and deliberately leaves _shapes_ unconstrained,
  "so tools can carry whatever data they need without amending the spec".
  Minting payload schemas under `schemas.afps.dev` asserted a normative shape
  AFPS has not adopted, decided in this repository rather than through the AFPS
  change process. Withdrawing the claim is the honest state.

  Standardizing event payloads remains possible — as a spec change first
  (§events in `spec.md`, documents under `packages/schema/v0/events/`, a Pages
  job that copies them), and only then an attribute here.

  **Receivers reject `dataschema` on the wire.** The platform's ingestion
  envelope is `.strict()` and declares no such member, so an envelope carrying
  it 400s. That is safe because the platform / `PI_IMAGE` / `SIDECAR_IMAGE`
  trio is version-locked at boot (#1201): a pre-removal image cannot reach a
  post-removal receiver.

### Changed

- The canonical payload contract is now data: `CANONICAL_CONSTRAINTS` is a
  table of `{ path, holds }` entries that `isCanonicalRunEvent` iterates,
  replacing a hand-written `switch`. Behaviour is unchanged — the 60-fixture
  corpus pins every verdict — but the set of constrained field paths is
  recoverable again without parsing TypeScript.

  That set is what a coverage guard needs. `test/types/canonical-events.test.ts`
  derives it and asserts that each constraint is, for some fixture, the one
  that rejects it; a constraint added without a fixture violating it now fails
  by name. The previous guard derived the same set from generated JSON Schema
  documents and was lost when those were removed as unpublished (issue #1184).

- New export `firstViolatedConstraint(event)` — the path of the first
  constraint an event violates, or `undefined`. It backs the coverage guard and
  makes rejection reasons legible to callers.

### Removed — unused surface

- `composeCatalogs(...)` (`@appstrate/afps-runtime/bundle`). No production caller
  ever appeared: it was written for inline runs, but the platform's
  `RunPackageCatalog` needs owner tracking and a loud throw on a missed draft
  override, semantics a silent first-non-null fallback chain cannot express.
  `InMemoryPackageCatalog` stays — it is the reference `PackageCatalog`
  implementation, though its doc no longer claims to back inline runs.
- `writeBundleToFile(bundle, path)` (`@appstrate/afps-runtime/bundle`). Two
  lines over `writeBundleToBuffer`, with no caller outside a test; the platform
  writes bundle bytes to object storage, not to disk. Callers that want a file
  own the `writeFile`.
- `src/types/manifest.ts`, a pass-through re-export of `@afps-spec/schema` that
  existed so consumers would not need a direct dependency on the spec package.
  No consumer ever took it — every one, including this package, imports
  `@afps-spec/schema` directly.
- `apiCallToolName` left the `resolvers` barrel and `slugifyIntegrationId` is
  now module-private; neither had a consumer outside this package.

### Changed — the text/binary media-type set is no longer mirrored

- `http-call-core.ts` classified response bodies against a hand-copy of the
  media-type set in `@appstrate/core/mime`, guarded by a parity test. The set
  moved to `@appstrate/afps-shared/mime` (a `workspace:*` dependency here, and
  the dependency core itself re-exports verbatim), so both layers now read one
  definition and the parity test is gone with the copy. `isTextLikeMimeType`
  keeps its one documented deviation — an explicit `charset` parameter counts
  as a declaration of textness — and behaves identically otherwise.

### Added — `dataschema` URIs for canonical CloudEvent payloads

- New `@appstrate/afps-runtime/events` exports (`CANONICAL_EVENT_SCHEMAS`,
  `CANONICAL_EVENT_SCHEMA_VERSION`, `canonicalEventSchemaUri`): the seven
  canonical event `data` payloads (`memory.added`, `pinned.set`,
  `output.emitted`, `log.written`, `appstrate.progress`, `appstrate.error`,
  `appstrate.metric`) each have a stable, versioned schema URI.
- `buildCloudEventEnvelope` stamps the OPTIONAL CloudEvents `dataschema`
  attribute with the matching URI. Additive and non-breaking: no existing
  attribute changes, and the attribute is omitted for third-party
  (`@scope/tool.verb`) events and for canonical types whose payload does not
  actually satisfy the shape (`isCanonicalRunEvent` gates it).
- The URIs are identifiers, not documents — nothing serves them.
  `schemas.afps.dev/v0/events/*` 404s (the afps-spec Pages job publishes
  `packages/schema/v0/*.schema.json` flat, with no `events/` directory) and
  `schemas.appstrate.dev` was never stood up. This is conformant: CloudEvents
  1.0 §3.1 does not require `dataschema` to dereference.
- A Zod payload table, a JSON Schema 2020-12 generator
  (`buildCanonicalEventJsonSchema(s)`, `serializeCanonicalEventJsonSchema`),
  seven committed artifacts under `schemas/v0/events/` and a `schemas:generate`
  script existed here and were removed before release: they produced documents
  for the unserved URIs above, `schemas:generate` ran in no workflow, and the
  drift tests guarded a shape nobody could fetch. `isCanonicalRunEvent`
  (`src/types/canonical-events.ts`) is the payload contract. Rebuild the
  generator only together with the publication step.

### Removed — RFC 9457 problem+json layer

- `toProblem()`, `ProblemDetails`, `afpsErrorTypeUri()`, `AFPS_ERROR_CODES` and
  the `https://docs.appstrate.dev/errors/afps/{code}` URI namespace are gone
  from `@appstrate/afps-runtime/errors`. They were added and removed within the
  same unreleased cycle: no wire ever carried them. The platform serialises
  errors through `@appstrate/core/api-errors` plus
  `run-launcher/bundle-error-mapping.ts`, which translates this taxonomy into
  the platform's own catalogue. `ResolverError` and `AuthorizedUrisError` are
  unaffected; `WorkloadExitError` and `isAfpsError` were removed later in the
  same unreleased cycle (see "Removed — five unraised error classes and the
  `isAfpsError` marker" above). Build an HTTP envelope from `code` + `message`
  on the two surviving classes.

### Added — shared tool-result truncation

- `@appstrate/afps-runtime/runner` now exports `truncateToolResult` and
  `toolResultByteLimit` — byte-aware, UTF-8-safe truncation of tool-result
  payloads before they ride an `EventSink` (env-tunable via
  `TOOL_RESULT_BYTE_LIMIT`). Shared by every Runner that forwards tool results;
  previously duplicated inside the Pi runner.

### Added — Letta-style `note` + `pin` tools

- New `noteTool` (`note`) and `pinTool` (`pin`) replace `memoryTool`
  (`add_memory`) and `checkpointTool` (`set_checkpoint`). `pin` accepts
  a required `key` parameter — `key="checkpoint"` is the legacy
  carry-over slot, other keys (e.g. `"persona"`, `"goals"`) are
  first-class named pinned blocks.
- New canonical event `pinned.set` (carries `key` + `content` + optional
  `scope`). Replaces `checkpoint.set`. The reducer aggregates events
  into `RunResult.pinned: Record<string, PinnedSlot>`; the
  `key="checkpoint"` slot is mirrored into the legacy top-level
  `RunResult.checkpoint` field for backward compatibility.
- `PLATFORM_TOOLS` now keys on `note` / `pin` (and `output` / `report` /
  `log`).
- Platform prompt's memory section references `note({ content })` and
  `pin({ key, content })`. The `## Checkpoint` section instructs agents
  to update via `pin({ key: "checkpoint", content })`.

### Removed — two exports with no consumer (BREAKING)

- `narrowCanonicalEvent` (`@appstrate/afps-runtime/types`) — a one-line
  `isCanonicalRunEvent(e) ? e : null` wrapper whose only remaining caller was
  the reducer's `foldEvent`, which now calls the guard directly. The guard
  already declares `event is CanonicalRunEvent`, so switch exhaustiveness is
  unchanged; callers replace `narrowCanonicalEvent(e) !== null` with
  `isCanonicalRunEvent(e)`.
- `SkillRef` re-export (`@appstrate/afps-runtime/resolvers`, and the internal
  `resolvers/types.ts`) — its three usages lived in the deleted
  `bundled-skill-resolver.ts`. Import it from `@afps-spec/types` directly.

### Removed — `add_memory` / `set_checkpoint` tools (BREAKING)

- `memoryTool` / `add_memory` and `checkpointTool` / `set_checkpoint`
  are removed from `PLATFORM_TOOLS`. Agents that imported the system
  packages `@appstrate/add-memory` / `@appstrate/set-checkpoint` must
  switch to `@appstrate/note` / `@appstrate/pin`.
- `checkpoint.set` event type removed. Runners that emitted it must
  emit `pinned.set` with `key: "checkpoint"`.
- Compat aliases were intentionally not added; an earlier breaking change
  already required redeploys.

### Added — `set_checkpoint` tool + scope-aware `add_memory`

- New canonical event `checkpoint.set` (carries `data` + optional
  `scope: "actor" | "shared"`). Emitted by the renamed `set_checkpoint`
  tool — replaces the legacy `set_state` tool.
- `add_memory` tool now accepts an optional `scope` parameter; the
  emitted `memory.added` event carries the field through.
- `RunResult.checkpointScope` records the scope of the most recent
  checkpoint emit so platform finalize logic can route writes into the
  unified `package_persistence` store.
- Platform prompt section renamed `## Previous State` → `## Checkpoint`
  and now documents the scope default (`"actor"`) for both tools.

### Removed — `set_state` tool + `state.set` event (BREAKING)

- `stateTool` / `set_state` removed from `PLATFORM_TOOLS`. Agents that
  emitted `state.set` must rebuild against `set_checkpoint`.
- `StateSetEvent` removed from the canonical-event union; the reducer +
  narrower no longer fold it. `RunResult.state` renamed to
  `RunResult.checkpoint`.
- Bundles depending on `@appstrate/set-state@1.0.0` no longer resolve;
  depend on `@appstrate/set-checkpoint@2.0.0` instead.

### Removed — `afps run` and `afps test` subcommands (BREAKING)

- **`afps run <bundle>` is gone.** Live LLM execution now lives
  exclusively in the `appstrate` CLI (`apps/cli`), which bundles this
  runtime as a workspace dependency and drives the same `PiRunner`
  code path — plus profile / credential-proxy / HMAC sink wiring the
  runtime CLI never had.
  Migration: the previous `afps run` surface, without an Appstrate instance,
  is
  `appstrate run <bundle> --integrations=none --report=false --model-source=env --model-api=<api> --model=<id> --llm-api-key=<key> --snapshot <path> --input <json>`.
- **`afps test <bundle> --events <path>` is gone.** Scripted-replay of
  user events through `EventSink.handle` + `reduceEvents` is a
  10-line library call; the CLI wrapper added no behaviour. A ready
  snippet ships in the README and in
  `examples/briefing-agent/README.md`.
- The `afps` binary is now strictly bundle tooling: `keygen` / `sign`
  / `verify` / `inspect` / `render` / `conformance`. Removes the only
  command that dynamically imported `@appstrate/runner-pi` and shrinks
  the CLI surface by two commands.

### Changed — earlier in this branch

- **`afps run --events <path>` had already been renamed to
  `afps test --events <path>`.** Both verbs are now removed; the
  rename entry is kept for historical reference.

### Added — Bundle format v1

- Multi-package `Bundle` contract per [`BUNDLE_FORMAT_SPEC.md`](../../docs/architecture/BUNDLE_FORMAT_SPEC.md) §4:
  - Types: `Bundle`, `BundlePackage`, `PackageIdentity`, `BundleMetadata`, `PackageCatalog`, `ResolvedPackage`, `BundleError`, `BUNDLE_FORMAT_VERSION` (`"1.0"`).
  - Integrity chain: per-file hashes in `RECORD` (`sha256=<b64-no-pad>`, PEP 427), per-package SRI digest over the RECORD, bundle-level SRI over the canonical packages map. `metadata` excluded from integrity per spec §4.5.
  - Canonical JSON serializer + deterministic ZIP writer (pinned DOS epoch `mtime`, STORE compression, sorted keys/paths).
  - `readBundleFromFile`/`Buffer`, `writeBundleToFile`/`Buffer` with full §10 conformance (archive sanitization, resource limits, MAJOR-version rejection).
- Catalog utilities:
  - `emptyPackageCatalog` singleton for zero-dep roots.
  - `InMemoryPackageCatalog` (exact + dist-tag + semver range resolution via `semver`).
  - `composeCatalogs(...)` fallback chain (first non-null `resolve` wins; `fetch` routes to the resolving catalog).
- Builders:
  - `buildBundleFromCatalog(root, catalog, opts)` — transitive walk, diamond dedup, cycle tolerance with `onWarn` callback, batched `DEPENDENCY_UNRESOLVED` error.
  - `buildBundleFromAfps(archive, catalog, opts)` — single `.afps → Bundle` conversion primitive used by every ingestion boundary (platform, CLI, GitHub Action).
  - `extractRootFromAfps(archive)` — raw AFPS ZIP → `BundlePackage`.
- `validateBundle(bundle)` — per-package AFPS schema check (agent/skill/tool/provider), cycle detection, divergent-version detection (both SHOULD-level warnings per spec §8).

### Changed — one Bundle path

- **Runtime hot path** speaks `Bundle` end-to-end. `RunOptions.bundle`, resolvers (`ToolResolver` / `SkillResolver` / `ProviderResolver`), `buildProviderExtensionFactories`, `prepareBundleForPi`, `runtime-pi/entrypoint.ts`, and all apps (`apps/api/routes/runs.ts` `buildRunnerBundle`, `apps/cli/commands/run.ts`) migrated from the legacy `LoadedBundle` surface to spec `Bundle`. `providerPrefix` option dropped across Sidecar / Local / Remote resolvers (each provider is its own package now).
- **Three ingestion paths**: `readBundleFromBuffer` (`.afps-bundle`), `buildBundleFromAfps` (`.afps` single-package → Bundle-of-1), `buildBundleFromCatalog` (in-memory). Any other ingestion shape is gone.
- **`canonicalBundleDigest(bundle: Bundle)`** — single signature, takes a `Bundle` directly. **Sig semantics now bind the full Merkle root**: the digest is derived from `Bundle.integrity` (recomputed as if `signature.sig` were absent) and emitted as UTF-8 canonical JSON `{ bundleFormatVersion, root, integrity }`. A tampered byte in ANY file of ANY package invalidates the signature — previously only root-package files were covered. Callers no longer maintain their own root-files flatteners. Breaking: bundles signed by pre-#247 runtimes need to be re-signed. No existing signed bundles in production at `0.0.0`, so no migration action required.
- **CLI commands** (`sign`, `verify`, `inspect`, `render`, `run`) use `readBundleFromBuffer`; `sign` rebuilds the bundle via `writeBundleToBuffer` after injecting `signature.sig`.
- **Signature read** (`readBundleSignature(bundle: Bundle)`) reads `signature.sig` from the root `BundlePackage`.

### Removed — legacy single-package surface

- `LoadedBundle` type, `loadBundleFromBuffer` / `loadBundleFromFile`, `BundleLoadError` (`src/bundle/loader.ts`).
- `bundleToLoadedBundle`, `loadedBundleToBundle`, `loadAnyBundleFromBuffer`, `loadAnyBundleFromFile`, `bundleOfOneFromAfps` migration bridges (`src/bundle/bridge.ts`).
- `validateAfpsManifest` over flat projection (`src/bundle/validator.ts`) — `validateBundle` over spec `Bundle` supersedes it.
- `canonicalBundleDigest(files: Record<string, Uint8Array>, exclude?)` legacy signature — replaced by `canonicalBundleDigest(bundle: Bundle)`.

### Dependencies

- Added `semver ^7.7.1` to support range + dist-tag resolution in catalogs.

## [0.0.0] — 2026-04-20

Initial placeholder release to claim the npm name `@appstrate/afps-runtime`.
No functional code — package skeleton only.

### Added

- Package skeleton (Phase 0 of extraction plan).
- Apache-2.0 license + NOTICE with MIT attributions for the Pi Coding Agent SDK.
- Publish workflow reserved for tag `afps-runtime@X.Y.Z`.
