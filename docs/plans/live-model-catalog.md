# Live model catalog

A model a vendor ships becomes selectable on a running instance without a
platform release or a redeploy.

Today the offer is the registry bundled with the pinned `@earendil-works/pi-ai`
(#1554). A new model needs a Pi release, then a bump PR, a platform release and
a deploy. The Pi release is fast (a version every few days). The other three
steps are ours, and #1705 measured them: ten Pi versions behind, one of them a
major.

## What stays true

- **One record lists a model and formats its requests.** No second source: the
  live catalog is Pi's own data at a later version, filtered to what the pinned
  code can serve.
- **The bump stays** for everything that is not a new model: Pi code, removals,
  price or limit changes on an existing id, featured lists.
- **System models stay bundled-only.** `SYSTEM_PROVIDER_KEYS` is checked against
  the bundled registry at boot, as today. Remote data never decides whether an
  instance boots.

## Measured on #1705 (0.86.1 → 1.0.4)

- Pi's model data is plain JSON: 42 files, 980 KB, one per provider, under
  `dist/providers/data/`, shaped `{ <api>: { "chat:<id>": record } }`.
- Across those ten versions the record vocabulary gained no `compat` key and no
  thinking level. It gained two top-level fields (`inputLimits`, `type`) and two
  API shapes. All four breakages of the bump were code.
- `buildPiModel` (`packages/runner-pi/src/pi-model.ts`) reads eight fields of a
  record: `name`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `compat`,
  `contextWindow`, `maxTokens`. Every other field is already dropped.
- Four processes each read their own copy of the registry through it:

  | Process         | Call site                                      | Registry copy     |
  | --------------- | ---------------------------------------------- | ----------------- |
  | API             | `model-catalog.ts`, `pi-chat/model-binding.ts` | platform image    |
  | Agent container | `runtime-pi/env.ts` `buildPiModelFromEnv`      | runtime image     |
  | Sidecar         | `pi-messages-backend.ts` `buildBackingModel`   | sidecar image     |
  | CLI             | `apps/cli/src/commands/run/model.ts`           | the installed CLI |

  Updating the API's view alone would list a model three other processes cannot
  format. That is the real obstacle, and step 1 removes it.

## Step 1: the dialect rides the wire

The API resolves the record once and hands every consumer what it needs. No
other process looks a model up.

The resolved values (`reasoning`, `input`, `cost`, `contextWindow`,
`maxTokens`) already travel. What is missing is the rest of the record, the
**dialect**: `{ name, thinkingLevelMap?, compat? }`.

- `ResolvedModel` gains `dialect`, read from the catalog next to
  `resolveCatalogDefaults` (`apps/api/src/services/org-models.ts`).
- `PiModelSpec` takes `dialect` in place of `registryModelId`; `buildPiModel`
  stops calling `getPiModel`. The record's limit fallbacks move to the API
  resolver, which already computes them.
- **Container:** `buildRuntimePiEnv` emits `MODEL_DIALECT` (JSON), for a
  non-aliased run only. `runtime-pi/env.ts` parses it.
  `alias-env-allowlist.test.ts` keeps pinning the aliased env as an exact set.
- **Sidecar:** `ModelSwap.backing` gains `dialect` (`@appstrate/core/sidecar-types`,
  a published type: additive, next core minor). It stays on the private
  `PI_MODEL_SWAP_JSON` channel.
- **Chat and CLI:** `GET /api/models` gains `pi_dialect`, opaque, `null` for a
  gateway and withheld from an alias like `pi_provider`. The chat binding and
  `run/model.ts` build from it.
- Absent dialect means "no record", which is already a gateway's case. No
  fallback to a local lookup.
- `runtime-pi/sidecar/pi-sdk.ts` keeps `builtinProviders()`: that is code (the
  provider stream implementations), not catalog data.

No behaviour change. The proof is the existing byte-identity suites, unchanged
in what they assert: `apps/api/test/unit/pi-model-parity.test.ts`,
`runtime-pi/sidecar/test/pi-messages-backend.test.ts`,
`llm-proxy-adapters.test.ts`.

This step is worth merging alone: one resolver instead of four.

## Step 2: the instance reads a signed catalog

`apps/api/src/services/model-catalog-overlay.ts` accepts a file and holds the
accepted one in memory, with no database and no network behind it;
`model-catalog-sync.ts` reads the channel and the table.

### The file

`${MODEL_CATALOG_URL}/pi-<PI_SDK_VERSION>.json` plus a detached `.sig`. Keyed by
the exact Pi version: a file is built for one version of the code and read by
no other.

```json
{
  "schema": 1,
  "sdk_version": "1.0.4",
  "source_version": "1.0.9",
  "serial": 1791300000,
  "records": [
    {
      "provider": "anthropic",
      "api": "anthropic-messages",
      "id": "…",
      "name": "…",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 0,
      "maxTokens": 0,
      "thinkingLevelMap": {},
      "compat": {}
    }
  ]
}
```

The envelope is ours. A record is a fragment of a Pi registry record, in Pi's
own spelling: the provider key, the API shape, the id and the eight fields a
model is built from, copied as they are. Nothing else is allowed in: never a
`baseUrl`, never `headers`. A hostile record must not be able to redirect an
authenticated request.

### Acceptance, on the instance

A file is applied only when all of these hold, checked again on every load:

1. Ed25519 signature (canonical base64, raw 64 bytes) over the exact bytes,
   against `MODEL_CATALOG_PUBLIC_KEY`, a constant in the source.
2. Strict Zod parse: an unknown field anywhere refuses the file.
3. `sdk_version` equals `PI_SDK_VERSION`.
4. Per record, the **vocabulary gate**: some bundled record of the same Pi
   provider speaks its API shape; every thinking level is one the platform
   knows, mapped to an effort word a bundled record of that API shape uses;
   every `compat` key is used by a bundled record of that API shape, and so is
   every non-boolean `compat` value (a string value is a branch in Pi's code).
   The vocabulary is the API shape's, not the provider's: a dialect is read by
   the code of the API it is spoken over. The keys `PLATFORM_MODEL_COMPAT`
   overrides are not weighed: their value is never read.
5. **Additive only**: a record whose `(provider, id)` the bundled registry has
   is skipped.

A record that fails 4 or 5 is skipped and logged. A file that fails 1 to 3 is
refused whole and the stored one stays.

One more rule sits at the write, in SQL, so that concurrent replicas cannot
undo it: a file replaces the stored one only with a higher `serial`, or as the
very same file (same signature). A lower serial is a rollback; the stored
serial under other bytes is not the file that was stored.

What the signature does not settle, on purpose:

- **The channel can withhold.** Whoever serves the file can keep serving an old
  one, or none: a withdrawal reaches an instance only if the channel delivers
  it. A signed expiry would close that, at the price of every instance dropping
  its models whenever the producer stops for a few days. Not taken.
- **First contact has no floor.** An instance that stored nothing accepts any
  file ever published for its Pi version.

### Wiring

- **Storage:** the core table `model_catalog_overlays` (`sdk_version` PK,
  `serial`, `payload`, `signature`, `checked_at`), migration `0079`. The file
  is kept byte for byte as text: `jsonb` would reformat what was signed. An
  instance reads and writes the row of its own Pi version, so the replicas of a
  rolling deploy across a Pi bump keep theirs; a row of another version that
  nobody confirmed for thirty days is deleted. A restart without network keeps
  the offer.
- **Sync:** one timer per process, every minute (`startModelCatalogSync`). A
  pass serves the stored row when its signature is not the one already served
  (one small read otherwise), and asks the channel when the row's last
  confirmation (`checked_at`, shared through the row) is older than six hours
  or when the process serves no file. So one replica fetches and the others
  follow within a minute, with no queue and no bus. A queue job runs once per
  cluster, which is the wrong shape here: every process must reload.
- **Channel read:** two GETs (the file, then its `.sig`), redirects refused,
  10 s timeout, 2 MB cap, no conditional request: the file holds only the
  models the bundled registry lacks and is a few kilobytes. The two GETs are
  not atomic; a publication between them fails the signature and the next
  attempt reads a consistent pair. A 404 means no file for this Pi version. Any
  answer that stores nothing makes this process wait an hour before asking
  again. Boot serves the stored row before the scheduler starts and never
  waits on the network.
- **Merge point:** `apps/api/src/services/model-catalog.ts` only.
  `listCatalogModels`, `lookupCatalogModel` and `lookupCatalogDialect` take a
  scope, `all` (default: bundled plus overlay) or `bundled`, so
  `restrictsToOffer` follows with no change at its call sites.
- **Who reads `bundled`:** the boot rules (featured ids, the inference-probe
  check, `SYSTEM_PROVIDER_KEYS` models), `verify:system-models`, and a system
  model's price, limits and dialect at run time. OpenRouter takes any id as a
  system model, so one could name an id only the overlay records: the platform
  pays for it, and remote data prices nothing the platform pays for. The offer
  snapshot test stays bundled-only and deterministic.
- **Subscription providers** (`authMode: "oauth2"`) are offered no overlay
  record with a price tier one request can reach, the rule
  `verify:system-models` holds the bundled registry to (#1552).
- **Env:** `MODEL_CATALOG_URL` (`http`/`https`). Empty disables the read; the
  stored row stays, unread.
- **A model whose record is gone** — withdrawn, channel switched off, or a Pi
  bump whose file is not read yet — keeps its `org_models` row and runs
  without catalog defaults or dialect, unpriced: the same state as an id a Pi
  bump drops. During the minute replicas take to agree, one may refuse a
  `POST /api/models` another would accept.

## Step 3: CI produces the file

`scripts/build-model-catalog.ts`, run from a release checkout so the pinned Pi
code is the one the file is built for:

1. `npm pack @earendil-works/pi-ai@latest`, extract `dist/providers/data/*.json`
   only. Nothing from the tarball is imported or executed.
2. Strict parse of the layout. An unknown layout fails the job: the overlay
   freezes at its last content until the next bump.
3. Keep the records of wired providers, on their API shape, absent from the
   bundled registry.
4. Apply the vocabulary gate (same function as the instance).
5. **Proof:** for each kept record, build the request with the pinned code for
   every supported thinking level, with and without a tool, no network (the
   `capturePayload` harness of `packages/runner-pi/test/pi-payload.ts`, moved
   out of `test/`), and run it through the llm-proxy adapter guards. A record
   that throws or loses a header is dropped and reported.
6. Emit canonical JSON, sign with a dedicated key
   (`scripts/sign-firecracker-manifest.ts` is the template).

`.github/workflows/publish-model-catalog.yml`: scheduled every six hours plus
`workflow_dispatch`, for the latest release tag and `main`, deduplicated by Pi
version. It publishes under `model-catalog/` on the `installer-pages` branch,
sharing the concurrency group of `publish-installer.yml`. The job summary lists
what was added and what the gate or the proof dropped. `release.yml` dispatches
it for a new tag so the file exists at deploy time.

A file is published for every Pi version in use even when it lists nothing, so
a 404 stays an anomaly and an instance that just moved to a new Pi version
finds its file. `serial` only ever grows, across key rotations too: the
publication time in seconds. An empty file with a higher serial is also the
kill switch: every instance the channel reaches drops its overlay.

## Order

| PR  | Content                                                                                 | Effect alone                   |
| --- | --------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | Step 1                                                                                  | none visible; one resolver     |
| 2   | Step 2 (table, env, reader)                                                             | inert: the file does not exist |
| 3   | Step 3, signing key, `docs/architecture/MODEL_CATALOG.md`, `SUPPLY_CHAIN.md`, CHANGELOG | live after the next release    |

Each PR carries the `integration` and `e2e` labels. #1705 merges first.

## What this does not solve

- **Pi must still publish the model.** Days at most. Removing that wait is the
  separate "unlisted model shaped like a known one" feature.
- **A model that needs new Pi code** waits for the bump: the gate or the proof
  drops it.
- **Same vocabulary, new semantics.** The gate cannot see a model that reuses
  known keys but needs behaviour the pinned code lacks. The vendor answers 400
  at first use. A live canary in the producer would catch it; not in this plan.
- **The price of a new model is Pi's, unreviewed by us.** Same authority as the
  bundled prices (#1554), without the human reading the snapshot diff.
- **A compromised signing key** can add models with a wrong price or dialect. It
  cannot redirect traffic, alter an existing id, or touch a system model.

## Decisions

1. **`MODEL_CATALOG_URL` is on by default**, pointing at `get.appstrate.dev`,
   for every instance: anonymous GETs of two static files. Empty disables it.
2. **An overlay model carries Pi's price.** Unpriced until the bump would make
   its usage free wherever usage is billed from the ledger.
3. **A CLI that receives a Pi provider and no dialect refuses** ("too old for
   this CLI") instead of building a request with the default dialect. Shipped
   with step 1.
4. **A signing key dedicated to this workflow**, since it runs unattended, not
   the release key.
