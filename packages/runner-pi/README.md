# `@appstrate/runner-pi`

`PiRunner` — an AFPS Runner implementation backed by the
[Pi Coding Agent SDK](https://github.com/badlogic/pi-mono). It executes an AFPS
agent bundle against an LLM and streams the resulting events to a sink.

This is the runner [Appstrate](https://github.com/appstrate/appstrate) itself
uses inside its sandboxes, extracted so the same execution semantics are
available in any Bun environment with an LLM API key — no platform, no database,
no containers required.

> **Status: not yet published.** The package is staged for release
> (`version: 0.0.0`) but still resolves `@appstrate/mcp-transport` as a workspace
> dependency, and that package is private. Consume it from the monorepo for now.

**Requires Bun ≥ 1.3.9.** Ships raw TypeScript sources; Node cannot import it
directly.

## Peer dependencies

The Pi SDK is a peer, pinned exactly — the runner tracks its event and session
shapes closely enough that a floating range would break silently:

```json
"@earendil-works/pi-coding-agent": "0.84.2",
"@earendil-works/pi-ai": "0.84.2"
```

## Exports

Two subpaths, both declared in `package.json`. `src/index.ts` is the authoritative
list — the groups below say what each cluster is FOR; they are not a narrower
"supported subset", and nothing enforces one.

| Subpath           | Contents                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `.`               | Everything below.                                                         |
| `./runtime-tools` | The built-in runtime tools the agent can call during a run, on their own. |

From `.`:

- **Running an agent** — `PiRunner` and its options (`PiRunnerOptions`,
  `PiModelConfig`), `derivePiCompactionSettings`,
  `prepareRequestedThinkingLevel` / `preserveRequestedThinkingLevel`,
  `setPiRuntimeCredential`.
- **Observing a session** — `installSessionBridge` plus `BridgeableSession` and
  `InternalSink`, for a host that wants to attach to a session it already owns.
- **Provider mapping** — `deriveProviderFromApi`, `PROVIDER_BY_API`.
- **Pi SDK import surface** — `Type`, `loadPiCodingAgentSdk`, and the SDK types
  (`Api`, `Model`, `Message`, `ExtensionAPI`, `ExtensionFactory`) re-exported so
  consumers never import the vendor package directly. See `src/pi-sdk.ts`.
- **Bundles and extensions** — `prepareBundleForPi`,
  `buildApiCallExtensionFactory`.
- **Container plumbing** (what Appstrate's own sandbox uses) —
  `buildRuntimePiEnv`, `pickOperatorSidecarEnv`, `SIDECAR_OPERATOR_ENV_KEYS`,
  `emitRuntimeReady`, `emitBootProgress`, `startSinkHeartbeat`.
- **Runtime tools** — `RUNTIME_INJECTED_TOOLS` and friends,
  `buildRuntimeToolFactories`, `callToolResultToPi`, `buildRuntimeToolExtensions`,
  `buildPublishDocumentExtension`, `spillResourcesToWorkspace`.

## What it handles

- **Run execution** — drives a Pi session over an AFPS bundle and emits AFPS
  runtime events to the configured sink.
- **Provider mapping** — resolves an API shape to its Pi provider
  (`deriveProviderFromApi`).
- **Compaction** — derives the Pi context-compaction settings for a run.
- **Session bridging** — `installSessionBridge` attaches an existing session so a
  host application can observe or extend it.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
