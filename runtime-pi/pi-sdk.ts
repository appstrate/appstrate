// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi Coding Agent SDK
 * (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) inside the
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
export { Type } from "@mariozechner/pi-ai";

// --- types ---
export type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
export type { Api, Model } from "@mariozechner/pi-ai";
