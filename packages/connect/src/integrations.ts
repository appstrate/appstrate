// SPDX-License-Identifier: Apache-2.0

/**
 * Subpath barrel for the integration runtime/MITM surface.
 *
 * The main `@appstrate/connect` entry re-exports `encryption.ts`
 * (depends on `@appstrate/env`) and `token-refresh.ts` (depends on
 * `@appstrate/db/schema`) — pulling them into a credential-isolating
 * consumer like the sidecar would defeat the isolation invariant and
 * bloat the single-file Bun-compiled binary with drizzle/postgres/wasm.
 *
 * This subpath exposes ONLY the integration-spawn, MITM planning, and
 * per-run CA primitives the sidecar (and future external runners) need.
 * Every module re-exported here is dependency-clean — they import from
 * `@appstrate/core/*` and sibling `./proxy-primitives.ts` only, never
 * from `@appstrate/db` or `@appstrate/env`.
 *
 * If you add a new export here, audit the module's top-level imports
 * first — adding anything that pulls in `@appstrate/db`/`@appstrate/env`
 * silently re-introduces the bug this subpath was created to prevent.
 */

export * from "./integration-credentials.ts";
export * from "./integration-mitm-planner.ts";
export * from "./proxy-ca-planner.ts";
