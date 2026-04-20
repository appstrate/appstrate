// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reserved interface — NOT IMPLEMENTED in v1.
 *
 * Future extension point for swapping the underlying agent session
 * backend (Pi SDK, Claude Agent SDK, OpenAI Agents SDK, Mastra, Vercel
 * AI SDK). In v1, `@appstrate/afps-runtime` ships `PiSessionProvider`
 * as the only implementation, adapting the MIT-licensed Pi SDK
 * (see ADR-010).
 *
 * Adding a second backend is deliberately deferred to Phase 11 of the
 * extraction plan, driven by user demand rather than speculation. The
 * interface is defined here so that future additions do not require
 * changes to the runtime's public API.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §6.
 */

/**
 * A factory producing agent sessions. Ship a concrete implementation
 * (e.g. `PiSessionProvider`) and pass it to `runBundle(...)` when
 * wiring up the runtime. The interface intentionally exposes no
 * methods in v1 — future revisions will add `createSession()` once a
 * second implementation is needed. Keeping it as an opaque marker
 * type today prevents speculative API surface.
 */
export interface AgentSessionProvider {
  /**
   * Marker property — set to `true` to satisfy the type. Replaced
   * with actual session lifecycle methods when a second backend is
   * implemented.
   */
  readonly _reserved: true;
}
