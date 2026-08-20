// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi Coding Agent SDK
 * (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`).
 *
 * This is the ONLY file in `@appstrate/runner-pi` allowed to import from
 * the Pi SDK directly — enforced by the `no-restricted-imports` ESLint
 * guard (see `eslint.config.mjs`). Every other module imports the symbols
 * it needs from here, so swapping or forking the single-vendor SDK is a
 * one-file change.
 *
 * Re-exports preserve type identity (`export type { ... }`), so consumers
 * see the exact same nominal types as a direct SDK import would yield.
 *
 * Rationale + fork-contingency plan: `docs/architecture/SUPPLY_CHAIN.md`.
 */

// --- cheap value (pi-ai, ~40ms) ---
// Used synchronously at tool-registration time to build parameter schemas,
// so it stays a static export.
export { Type } from "@earendil-works/pi-ai";
// Pi 0.84 moved the legacy API-dispatch helper behind its compatibility
// entrypoint. Appstrate still needs one generic dispatch seam for proxy-bound
// chat models; the provider implementation itself remains the current native
// module selected by Pi, including the native Mistral HTTP stream.
export { streamSimple } from "@earendil-works/pi-ai/compat";

// --- types (erased at runtime) ---
export type { ModelRuntime, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
export type {
  Api,
  KnownApi,
  Model,
  Transport,
  Context,
  Message,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

// --- heavy value surface (pi-coding-agent, ~200ms) behind a dynamic import ---
// `@earendil-works/pi-coding-agent` is the single most expensive module to
// evaluate in the runtime graph. The specifier appears ONLY inside the
// `import()` call below so that `bun build --outfile` keeps it OUT of the
// bundle's eager top-level graph: a *static* `export … from "…pi-coding-agent"`
// is hoisted to an eager top-level import, and even a static import reached
// only through a dynamically-imported internal module is hoisted eager — so the
// laziness MUST land on this external specifier directly. Callers await
// `loadPiCodingAgentSdk()` at session-build time; the container entrypoint warms
// it during the network-bound provisioning phase so the eval overlaps that I/O.
export type PiCodingAgentSdk = typeof import("@earendil-works/pi-coding-agent");
export function loadPiCodingAgentSdk(): Promise<PiCodingAgentSdk> {
  return import("@earendil-works/pi-coding-agent");
}
