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
// NOTHING TEST-ONLY BELONGS IN THIS FILE.
//
// Two re-exports lived here — `streamSimple` (from `pi-ai/compat`) and
// `getBuiltinProviders` (from `pi-ai/providers/all`) — on the stated grounds
// that the `no-restricted-imports` guard forbade a test from reaching the
// vendor directly. It did not: that guard's `files` list is
// `packages/runner-pi/src/**`, and has never covered `test/**`.
//
// The cost was real. `pi-ai/dist/providers` is 2.1 MB across ~45 statically
// imported provider modules, and `compat.js` pulls it too. The package ROOT
// does not — so before those two lines this graph was never evaluated. They are
// static exports, so every consumer of this barrel paid for them at import
// time: `runtime-pi/entrypoint.ts` at container boot, and `apps/api` through
// `module-chat`. That is the exact cost this file's header exists to avoid and
// `runtime-pi/Dockerfile` spends a bundling stage shaving.
//
// The tests import the vendor entrypoints directly.

// --- types (erased at runtime) ---
export type { ModelRuntime, ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
export type { Api, KnownApi, Model, Transport, Message } from "@earendil-works/pi-ai";
// The vendor's own event/usage shapes. Consumers keep their own narrow
// structural views (a mapper must stay testable with synthetic events, and the
// SDK value graph must stay behind `loadPiCodingAgentSdk()`); these exist so
// those views can be PINNED against the vendor at compile time. Type-only, so
// they are erased and drag nothing into the runtime graph.
export type { AgentSessionEvent as PiSdkAgentSessionEvent } from "@earendil-works/pi-coding-agent";
export type {
  AssistantMessageEvent as PiSdkAssistantMessageEvent,
  Usage as PiSdkUsage,
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
