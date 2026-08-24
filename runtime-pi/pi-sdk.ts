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
// No test-only re-export here either. The one that stood here claimed it
// "costs nothing in the image" because `pi-ai/compat` was already in the
// entrypoint's bundle graph through the runner's barrel — which was only true
// BECAUSE that barrel carried the same test-only re-export. Both are gone; the
// test imports `@earendil-works/pi-ai/compat` directly, which the supply-chain
// guard now exempts for `runtime-pi/**/test/**`.

// --- types ---
export type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
export type { Api, Model } from "@earendil-works/pi-ai";
