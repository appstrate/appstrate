# Live model catalog

A model a vendor ships becomes selectable on a running instance without a
platform release or a redeploy, as soon as Pi's registry records it.

The model catalog is the registry bundled with the pinned
`@earendil-works/pi-ai` (`apps/api/src/services/model-catalog.ts`). The live
catalog adds to it the records a **later** Pi registry holds and the **pinned**
Pi code can serve. It never replaces a bundled record: prices, limits and
dialects of an existing id, removals and anything that needs new Pi code still
arrive with the SDK bump.

```
npm: pi-ai@latest (JSON data only)
        │  publish-model-catalog.yml, every 6 h, one build per Pi version in use
        ▼
scripts/build-model-catalog.ts ── gate + proof + Ed25519 signature
        ▼
get.appstrate.dev/model-catalog/pi-<version>.json (+ .sig)
        │  model-catalog-sync.ts, each API process, at start and every hour
        ▼
model-catalog-overlay.ts (in memory) ── merged by model-catalog.ts
```

## The file

`${MODEL_CATALOG_URL}/pi-<PI_SDK_VERSION>.json` and a detached `.sig`. Keyed by
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

The envelope is ours. A record is a fragment of a Pi registry record in Pi's
own spelling: the provider, the API shape, the id and the eight fields a model
is built from. Nothing else is allowed in, never a `baseUrl`, never `headers`:
a record cannot redirect an authenticated request. `serial` is the publication
time in seconds and only ever grows.

## What an instance accepts

`model-catalog-overlay.ts`, on every read of the channel:

1. Ed25519 signature (base64, raw 64 bytes) over the exact bytes,
   against `MODEL_CATALOG_PUBLIC_KEY`, a constant in the source.
2. Strict parse: an unknown field anywhere refuses the file.
3. `sdk_version` equals `PI_SDK_VERSION`.
4. Per record, the **vocabulary gate**: some bundled record of the same Pi
   provider speaks its API shape; every thinking level is one the platform
   knows, mapped to an effort word a bundled record of that API shape uses;
   every `compat` key is used by a bundled record of that API shape, and so is
   every non-boolean `compat` value. The keys `PLATFORM_MODEL_COMPAT` overrides
   are not weighed: their value is never read.
5. **Additive only**: a record whose `(provider, id)` the bundled registry has
   is skipped.

A record that fails 4 or 5 is skipped and logged. A file that fails 1 to 3 is
refused whole and the one held stays. A file replaces the one a process holds
only with a higher `serial`. Every read that fails or is refused logs one
warning, so a process that cannot read its channel says so once an hour.

## Who reads it

Catalog lookups take a scope, `all` (bundled plus live) or `bundled`.

- **`all`:** what an organization binds with its own credentials, the pickers,
  model metadata.
- **`bundled`:** the boot rules (featured ids, the inference-probe check,
  `SYSTEM_PROVIDER_KEYS` models), `verify:system-models`, and a system model's
  price, limits and dialect at run time. Remote data decides neither whether an
  instance starts nor what a model the platform pays for costs.
- A **subscription provider** (`authMode: "oauth2"`) is offered no live record
  with a price tier one request can reach (#1552).

## Sync

`model-catalog-sync.ts`. Each API process reads the channel when it starts, in
the background, and every hour: two GETs, redirects refused, 10 s, 2 MB. Boot
never waits on the network. The accepted file lives in memory and nowhere
else.

Nothing is stored, on purpose. The bundled registry is always loaded, so a
stored copy would only protect the models the catalog adds, for the second a
restarted process needs to read the channel. That is not worth a table.

It is not a `createCache` either (`apps/api/AGENTS.md`, "Caching"): that
primitive is an asynchronous read-through of single rows, and the catalog is
read synchronously by every lookup of a model. It is process state loaded at
start, like the model-provider registry, refreshed on a timer.

`MODEL_CATALOG_URL=off` starts nothing: the instance runs on the bundled
registry alone. An empty value does not: like every variable here it then
takes its default, the public channel.

## The producer

`scripts/build-model-catalog.ts`, run by
`.github/workflows/publish-model-catalog.yml` from the checkout that pins the
Pi version the file is for, so the code that weighs a record is the code that
will serve it.

1. The workflow downloads the latest `@earendil-works/pi-ai` tarball and
   extracts its `package.json` and `dist/providers/data`. Nothing of it is
   installed, imported or run.
2. The script reads the chat records as Pi's own loader does, and stops on a
   layout it does not know. A registry that is not later than the pinned one
   lists nothing.
3. A record absent from the bundled registry is published only if an instance
   would keep it (the same function), every field Pi wrote on it is one a
   bundled record of its API shape has, its endpoint is one a bundled record of
   its provider uses, and the pinned code builds its request at every thinking
   level, with no network (`capturePayload`, the harness the parity tests use).
   A reasoning record of a served API shape that takes `off` must also have
   what `off` sends derived (`piReasoningOff`) and agree with the payload the
   pinned code builds (`observedReasoningOff`): an instance serves the derived
   value.
4. The file is signed with `MODEL_CATALOG_SIGNING_KEY`, then read back exactly
   as an instance will: a seed that is not the pinned key's publishes nothing.
5. Nothing is published when the published file already lists the same records
   under a signature this checkout accepts.

Every six hours and on dispatch, for the two newest release tags and `main`,
one build per Pi version (a tag before `main`). The job summary lists what was
published and what was dropped, with the reason. A release's files are built
by that release's producer: a rule added on `main` reaches them with the next
release. Without the secret the
workflow warns and publishes nothing.

## Operating it

- **Key.** `bun scripts/sign-firecracker-manifest.ts --generate` prints a seed
  and its public key. The seed is the repository secret
  `MODEL_CATALOG_SIGNING_KEY`; the public key is `MODEL_CATALOG_PUBLIC_KEY` in
  `model-catalog-overlay.ts`. Dedicated to this workflow, which runs
  unattended: never the release key.
- **Rotating it** is a release: new constant, new secret. A build of the old
  constant refuses the files of the new key and keeps the file it holds.
- **Kill switch.** Disable the workflow, then publish an empty file under a
  higher serial: run the script with `--source-version` set to the pinned
  version (a registry that is not later lists nothing) and push its output to
  `model-catalog/` on the `installer-pages` branch. Every instance the channel
  reaches drops its live models within the hour. Editing the published JSON
  by hand does nothing: the signature covers the bytes. One model that Pi
  still lists cannot be withdrawn alone.
- **A model whose record is absent** (withdrawn, channel switched off, a Pi
  bump whose file is not published yet, a process that restarted and has not
  read the channel) keeps its `org_models` row and runs without catalog
  defaults or dialect, unpriced: the same state as an id a Pi bump drops.

## What it does not do

- **Pi must still publish the model.** The live catalog removes our release
  and deploy from the wait, not Pi's.
- **A model that needs new Pi code** waits for the bump: the gate or the proof
  drops it.
- **Same vocabulary, new semantics.** A model that reuses known words but needs
  behaviour the pinned code lacks is published; the vendor answers 400 at first
  use.
- **The price of a new model is Pi's**, read by no human before it is offered.
- **The channel can withhold.** Whoever serves the file can keep serving an old
  one, or none. A signed expiry would close that, at the price of every
  instance dropping its models whenever the producer stops for a few days.
- **A process that just started has no floor.** It holds no file, so it
  accepts any file ever published for its Pi version.
- **Replicas agree within the hour**, not at once: each reads on its own.
- **A compromised signing key** can add models with a wrong price or dialect.
  It cannot redirect traffic, alter an existing id, or touch a system model.
