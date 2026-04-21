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
  ships its own implementations of the open interfaces (`HttpSink`,
  `AppstrateContextProvider`, `AppstrateCredentialProvider`).
- **Reproducible.** A run can be recorded (file sink → `.jsonl`) and replayed
  via `afps run --events <file>` with identical structural behaviour.
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
  run <bundle>        Execute a bundle using the MockRunner
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
afps run my-agent.afps --events events.json --output result.json

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
  SnapshotContextProvider,
  MockRunner,
  ConsoleSink,
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

// Rendering the prompt
const provider = new SnapshotContextProvider({
  memories: [{ content: "prior finding", createdAt: Date.now() }],
});
const prompt = await renderPrompt({
  template: bundle.prompt,
  context: { runId: "run_1", input: { topic: "birds" } },
  provider,
});

// Executing (scripted, deterministic)
const runner = new MockRunner({
  events: [
    { type: "log", level: "info", message: "hello" },
    { type: "add_memory", content: "learned something" },
    { type: "output", data: { done: true } },
  ],
});
const result = await runner.run({
  bundle,
  context: { runId: "run_1", input: {} },
  sink: new ConsoleSink(),
  contextProvider: provider,
});
```

### Package subpath exports

| Subpath                               | What                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| `@appstrate/afps-runtime`             | Everything — re-exports all modules                           |
| `@appstrate/afps-runtime/bundle`      | Loader, validator, hash, signing, prompt rendering            |
| `@appstrate/afps-runtime/runner`      | `BundleRunner`, `MockRunner`, `reduceEvents`                  |
| `@appstrate/afps-runtime/interfaces`  | `EventSink`, `ContextProvider`, `CredentialProvider`, …       |
| `@appstrate/afps-runtime/providers`   | Built-in providers (snapshot, file, env, …)                   |
| `@appstrate/afps-runtime/sinks`       | `ConsoleSink`, `FileSink`, `HttpSink`, `CompositeSink`        |
| `@appstrate/afps-runtime/events`      | CloudEvents envelope, Standard Webhooks signing, JSONL parser |
| `@appstrate/afps-runtime/template`    | Logic-less Mustache with JSON sanitisation                    |
| `@appstrate/afps-runtime/conformance` | Adapter interface + built-in cases + report runner            |
| `@appstrate/afps-runtime/types`       | `AfpsEvent`, `ExecutionContext`, `RunResult`, …               |

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

| Level  | Scope           | Representative case                                        |
| ------ | --------------- | ---------------------------------------------------------- |
| **L1** | Bundle loader   | Rejects a ZIP missing `manifest.json`                      |
| **L2** | Prompt renderer | Strips function-valued context fields                      |
| **L3** | Signing         | Verifies a 1-hop trust chain, rejects untrusted root       |
| **L4** | Execution       | Event `sequence` monotonic, `sink.finalize()` exactly once |

L4 adapter method is optional — implementations that only cover
loading/rendering/signing have L4 cases automatically marked `skipped`.

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
├── events.json             # AfpsEvent[] replayed by MockRunner
├── context.json            # ExecutionContext passed to runBundle
└── snapshot.json           # SnapshotContextProvider input
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

No Pi SDK coupling at the core level — the `PiRunner` implementation
lazy-imports `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai`
on first `.run()` call, so consumers who only use `MockRunner` never
pull the SDK.

## Running against a real LLM — PiRunner

`PiRunner` wires the 5 AFPS platform tools (`add_memory`, `set_state`,
`output`, `report`, `log`) as Pi extensions whose `execute` pushes the
matching `AfpsEvent` through your sink in-process — same contract as
`MockRunner`, same reducer, same envelope.

```sh
# Install the optional peer deps
bun add @mariozechner/pi-coding-agent @mariozechner/pi-ai

# Run against Anthropic
export LLM_API_KEY=sk-ant-…
afps run agent.afps \
  --runner pi \
  --model claude-opus-4-7 \
  --api anthropic-messages \
  --context context.json \
  --snapshot snapshot.json
```

Or as a library:

```ts
import { PiRunner, ConsoleSink, SnapshotContextProvider, loadBundleFromFile } from "@appstrate/afps-runtime";

const runner = new PiRunner({
  model: { id: "claude-opus-4-7", api: "anthropic-messages" },
  apiKey: process.env.LLM_API_KEY!,
  thinkingLevel: "medium",
});
const bundle = await loadBundleFromFile("./agent.afps");
const result = await runner.run({
  bundle,
  context: { runId: "r1", input: { topic: "X" } },
  sink: new ConsoleSink(),
  contextProvider: new SnapshotContextProvider({ memories: [...] }),
});
```

Supported `--api` values: `anthropic-messages`, `openai-completions`,
`openai-responses`, `google-generative-ai`, `mistral-conversations`.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for
third-party attributions.
