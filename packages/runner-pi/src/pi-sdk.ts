// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi Coding Agent SDK
 * (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`).
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

// --- values ---
export {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
export { Type } from "@mariozechner/pi-ai";

// --- types ---
export type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
export type { Api, KnownApi, Model } from "@mariozechner/pi-ai";
