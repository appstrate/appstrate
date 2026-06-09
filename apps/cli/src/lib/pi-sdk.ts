// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi Coding Agent SDK
 * (`@mariozechner/pi-ai`) inside the `@appstrate/cli`.
 *
 * This is the ONLY file under `apps/cli/` allowed to import from the Pi
 * SDK directly — enforced by the `no-restricted-imports` ESLint guard
 * (see `eslint.config.mjs`). The CLI's surface is tiny (`Api`, `Model`
 * types only), but routing it through a barrel keeps the swap-cost
 * uniform with `runner-pi` and `runtime-pi`.
 *
 * Re-exports preserve type identity (`export type { ... }`).
 *
 * Rationale + fork-contingency plan: `docs/architecture/SUPPLY_CHAIN.md`.
 */

// --- types ---
export type { Api, Model } from "@mariozechner/pi-ai";
