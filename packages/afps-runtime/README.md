# @appstrate/afps-runtime

> **Status:** pre-1.0 — stable interfaces, library surface, and CLI. First published release targets `1.0.0-alpha.1`.

Portable, open-source runtime for loading, validating, signing, and executing
[AFPS](https://github.com/appstrate/afps-spec) (Agent Format Packaging
Standard) bundles. The same runtime powers Appstrate's hosted execution and
any machine — CI, edge, enterprise VM — that wants to run an AFPS agent
locally.

- **Execution-contract parity.** Appstrate and external runners load the
  exact same bundle through the exact same interfaces.
- **Zero coupling.** The runtime has no knowledge of Appstrate. Appstrate
  ships its own sink (`AppstrateEventSink`) and resolvers against the
  runtime's open surface.
- **Reproducible.** A run can be recorded (file sink → `.jsonl`) and
  replayed via `afps test --events <file>` with identical structural
  behaviour.
- **Apache-2.0.** Toolbox, not a platform — build whatever you want on top.

## Install

```sh
bun add @appstrate/afps-runtime
```

The package is Bun-first; Node ≥ 20 works for library usage but the `afps`
CLI shebang assumes `bun`.

## CLI

```
afps <command> [options]

  keygen              Generate an Ed25519 key pair
  sign <bundle>       Add signature.sig to a bundle (re-packs the ZIP)
  verify <bundle>     Validate manifest + template, verify signature
  inspect <bundle>    Print manifest, files, signature summary
  render <bundle>     Render the prompt template against a context
  test <bundle>       Replay a scripted RunEvent[] through the sink + reducer
  run <bundle>        Execute a bundle against a real LLM (Pi Coding Agent SDK)
  conformance         Run the AFPS conformance suite (L1–L4)
```

Each command exposes `--help` with per-option documentation.

### End-to-end example

```sh
# 1. Generate a signing key pair
afps keygen --out key.json

# 2. Produce a trust root mapping keyId → public key
jq '{ keys: [{keyId: .keyId, publicKey: .publicKey}] }' key.json > trust.json

# 3. Sign an existing bundle
afps sign my-agent.afps --key key.json

# 4. Verify
afps verify my-agent.afps --trust-root trust.json
# → ✓ manifest + template valid (3 files)
# → ✓ signature valid (keyId: …)

# 5. Inspect
afps inspect my-agent.afps --json | jq

# 6. Replay a recorded run
afps test my-agent.afps --events events.json --output result.json

# 7. Contract-test your implementation
afps conformance --json | jq '.summary'
```

## Library

```ts
import {
  loadBundleFromFile,
  validateBundle,
  canonicalBundleDigest,
  readBundleSignature,
  verifyBundleSignature,
  renderPrompt,
  reduceEvents,
  ConsoleSink,
  type RunEvent,
} from "@appstrate/afps-runtime";

const bundle = await loadBundleFromFile("./agent.afps");

// Validation
const validation = validateBundle(bundle);
if (!validation.valid) throw new Error(validation.issues[0].message);

// Signature verification
const sig = readBundleSignature(bundle);
if (sig) {
  const trustRoot = { keys: [{ keyId: "…", publicKey: "…" }] };
  const digest = canonicalBundleDigest(bundle.files);
  const result = verifyBundleSignature(digest, sig, trustRoot);
  if (!result.ok) throw new Error(`signature invalid: ${result.reason}`);
}

// Render the prompt — memories / state / history travel on the
// ExecutionContext; no provider bridge is involved.
const prompt = await renderPrompt({
  template: bundle.prompt,
  context: {
    runId: "run_1",
    input: { topic: "birds" },
    memories: [{ content: "prior finding", createdAt: Date.now() }],
  },
});

// Consume an event stream through a sink (produced by a runner you wire
// up externally — e.g. the spec-aligned `Runner` interface from
// `@appstrate/afps-runtime/runner`) and fold it into a RunResult.
const sink = new ConsoleSink();
const events: RunEvent[] = [
  { type: "log.written", timestamp: Date.now(), runId: "run_1", level: "info", message: "hello" },
  { type: "memory.added", timestamp: Date.now(), runId: "run_1", content: "learned something" },
  { type: "output.emitted", timestamp: Date.now(), runId: "run_1", data: { done: true } },
];
for (const ev of events) await sink.handle(ev);
const result = reduceEvents(events);
await sink.finalize(result);
```

### Package subpath exports

| Subpath                               | What                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `@appstrate/afps-runtime`             | Everything — re-exports all modules                                |
| `@appstrate/afps-runtime/bundle`      | Loader, validator, hash, signing, prompt rendering                 |
| `@appstrate/afps-runtime/runner`      | `Runner`, `RunOptions`, `reduceEvents`, `RunResult`                |
| `@appstrate/afps-runtime/interfaces`  | `EventSink` contract                                               |
| `@appstrate/afps-runtime/sinks`       | `ConsoleSink`, `FileSink`, `HttpSink`, `CompositeSink`             |
| `@appstrate/afps-runtime/resolvers`   | `ProviderResolver`, `ToolResolver`, `SkillResolver`, `ToolContext` |
| `@appstrate/afps-runtime/events`      | CloudEvents envelope + Standard Webhooks signing                   |
| `@appstrate/afps-runtime/template`    | Logic-less Mustache with JSON sanitisation                         |
| `@appstrate/afps-runtime/conformance` | Adapter interface + built-in cases + report runner                 |
| `@appstrate/afps-runtime/types`       | `RunEvent`, `ExecutionContext`, `RunResult`, `LogLevel`, …         |

## Conformance

The runtime ships a portable conformance suite (`L1`–`L4`) that a
third-party implementation passes by supplying a `ConformanceAdapter`:

```ts
import { createDefaultAdapter, runConformance, formatReport } from "@appstrate/afps-runtime";

const report = await runConformance(createDefaultAdapter());
console.log(formatReport(report));
// → 19/19 passed, 0 failed
```

Levels (from the spec):

| Level  | Scope           | Representative case                                     |
| ------ | --------------- | ------------------------------------------------------- |
| **L1** | Bundle loader   | Rejects a ZIP missing `manifest.json`                   |
| **L2** | Prompt renderer | Strips function-valued context fields                   |
| **L3** | Signing         | Verifies a 1-hop trust chain, rejects untrusted root    |
| **L4** | Execution       | Events emitted in arrival order, `sink.finalize()` once |

The L4 `runScripted` adapter method is optional — implementations that
only cover loading/rendering/signing have L4 cases automatically marked
`skipped`.

### Implementing the adapter in another language

Fixtures under [`fixtures/reference/`](./fixtures/reference) ship the
reference inputs + expected outputs so a Go / Rust / Python / whatever
runtime can prove parity without running this TypeScript code:

```
fixtures/reference/
├── bundle.afps             # signed reference bundle (ZIP)
├── bundle-unsigned.afps    # same bundle without signature.sig
├── key.json                # { keyId, publicKey, privateKey } (Ed25519, raw 32-byte base64)
├── trust-root.json         # { keys: [{ keyId, publicKey }] }
├── events.json             # RunEvent[] scripted replay (type/timestamp/runId + payload)
├── context.json            # ExecutionContext passed to render
└── snapshot.json           # { memories?, state?, history? } merged onto the context
```

Regenerate with `bun run scripts/build-fixtures.ts` (keys rotate each run
— fixtures pin the _structure_, not byte values).

A non-TS runner loads these, executes the same pipeline, and compares its
`RunResult` against the reference — ideally by running its own conformance
harness, but a simple golden-file diff is sufficient for L1-L3.

## Signing model

Artifact signing follows [ADR-009](../../docs/adr/ADR-009-afps-bundle-signing-ed25519-to-sigstore.md):

- **v1 — Ed25519 detached (shipped)**. `signature.sig` holds
  `{ alg, keyId, signature, chain? }`; verification pins trust by
  `keyId + raw publicKey` in a `TrustRoot`. `canonicalBundleDigest` gives
  a re-packing-stable digest (ZIP bytes are not a stable contract).

- **v2 — Sigstore keyless (roadmap)**. `verifySigstoreSignature` is stubbed
  today and ships in a follow-up release. The runtime accepts both formats
  during the migration; consumers that see `alg_unsupported` fall back
  to Ed25519.

Event-transport signing (Standard Webhooks HMAC-SHA256) is orthogonal and
lives under `@appstrate/afps-runtime/events` — see the signing module for
details.

## Dependencies

Runtime dependencies are intentionally minimal:

- **[`@afps-spec/schema`](https://www.npmjs.com/package/@afps-spec/schema)** — Zod schemas for AFPS manifests (CC-BY-4.0 / MIT)
- **[`fflate`](https://github.com/101arrowz/fflate)** — ZIP encode/decode (MIT, zero-dep, ~8 KB)
- **[`mustache`](https://github.com/janl/mustache.js)** — logic-less template rendering (MIT, zero-dep)
- **[`zod`](https://zod.dev)** — runtime type validation (MIT)

The runtime exposes a `Runner` interface under
`@appstrate/afps-runtime/runner` but does not ship a concrete LLM-backed
implementation in v1 — downstream projects (including Appstrate itself,
which delegates execution to a Docker container) implement the interface
with their own session backend.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for
third-party attributions.
