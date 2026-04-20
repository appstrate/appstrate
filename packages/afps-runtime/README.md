# @appstrate/afps-runtime

> **Status:** early — package skeleton. First functional release targets `1.0.0-alpha.1`. Not ready for production use.

Portable, open-source runtime for executing [AFPS](https://github.com/appstrate/afps-spec) agent bundles. The same runtime powers Appstrate's SaaS execution and any machine that wants to run an AFPS agent locally, in CI, on the edge, or inside an enterprise VM.

## Goals

- **Execution-contract parity.** Appstrate and external runners load the exact same package and wire the same interfaces. No forked code paths.
- **Zero coupling to Appstrate.** The runtime has no knowledge of Appstrate. Appstrate ships its own implementations of the open interfaces (`HttpSink`, `AppstrateContextProvider`, `AppstrateCredentialProvider`).
- **Reproducible runs.** Bundles exported from Appstrate can be downloaded and replayed anywhere with identical structural behavior.
- **Open core.** Apache-2.0. Built on top of the MIT-licensed [Pi Coding Agent SDK](https://github.com/badlogic/pi-mono).

## Design

See [`AFPS_EXTENSION_ARCHITECTURE.md`](../../../AFPS_EXTENSION_ARCHITECTURE.md) at the workspace root for the full architecture, interface contracts, signing strategies, and the SLSA-inspired conformance levels.

Implementation is sequenced in [`AFPS_RUNTIME_PLAN.md`](../../../AFPS_RUNTIME_PLAN.md).

## Install

```sh
# Not yet published — reserved for 1.0.0-alpha.1
bun add @appstrate/afps-runtime
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for third-party attributions.
