// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi Coding Agent SDK
 * (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) inside the
 * `runtime-pi` container image.
 *
 * This is the ONLY file under `runtime-pi/` allowed to import from the Pi
 * SDK directly — enforced by the `no-restricted-imports` ESLint guard
 * (see `eslint.config.mjs`). Every other module imports the symbols it
 * needs from here, so swapping or forking the single-vendor SDK is a
 * one-file change.
 *
 * Re-exports preserve type identity (`export type { ... }`).
 *
 * Rationale + fork-contingency plan: `docs/architecture/SUPPLY_CHAIN.md`.
 */

// --- values ---
export { Type } from "@earendil-works/pi-ai";
// Test-only payload probe, same role (and same reason for existing) as the
// re-export of the same name in `packages/runner-pi/src/pi-sdk.ts`: the
// `no-restricted-imports` guard forbids a test from reaching the vendor package
// directly, and `test/alias-dialect-opacity.test.ts` needs to capture the
// request body Pi would serialize for a model built by `buildPiModelFromEnv`.
// Costs nothing in the image — `@earendil-works/pi-ai/compat` is already in the
// entrypoint's bundle graph through the runner's own barrel.
export { streamSimple } from "@earendil-works/pi-ai/compat";

// --- types ---
export type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
export type { Api, Model } from "@earendil-works/pi-ai";
