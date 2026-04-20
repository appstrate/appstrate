// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Conformance adapter — the minimal surface an AFPS runner implementation
 * must expose to be exercised by the built-in test suite.
 *
 * A third-party runtime (Go, Rust, Python, a hosted service) passes a
 * {@link ConformanceAdapter} into {@link runConformance} to prove it
 * parses bundles, renders prompts, and verifies signatures
 * bit-compatibly with the reference implementation.
 *
 * Level 4 (bundle execution → event stream) is reserved for Phase 10 —
 * today the adapter's `runBundle` field is intentionally absent from
 * the type.
 */

import type { LoadedBundle } from "../bundle/loader.ts";
import type { TrustRoot, VerifySignatureResult } from "../bundle/signing.ts";
import type { ContextSnapshot } from "../providers/context/snapshot-provider.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type { AfpsEvent, AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunResult } from "../types/run-result.ts";

export interface ConformanceAdapter {
  /** Human-readable name used in the final report. */
  readonly name: string;

  /**
   * Parse a ZIP buffer into a LoadedBundle. MUST throw on malformed
   * input (non-ZIP, missing manifest.json, missing prompt.md, etc.);
   * the suite treats "did not throw" as a pass for the negative cases.
   */
  loadBundle(bytes: Uint8Array): LoadedBundle;

  /**
   * Render a bundle's prompt template against a context + snapshot.
   * MUST strip function/symbol values (logic-less template guarantee).
   */
  renderPrompt(
    template: string,
    context: ExecutionContext,
    snapshot: ContextSnapshot,
  ): Promise<string>;

  /**
   * Verify a detached signature against a trust root. Receives the
   * canonical digest bytes already computed by the suite so the
   * implementation under test never has to reimplement
   * {@link import("../bundle/signing.ts").canonicalBundleDigest}.
   */
  verifySignature(
    canonicalBytes: Uint8Array,
    signatureDoc: unknown,
    trustRoot: TrustRoot,
  ): VerifySignatureResult;

  /**
   * L4 — scripted execution. Given a bundle, context, and a scripted
   * event list, the adapter MUST:
   *
   * 1. Emit each event through its internal sink with a monotonically
   *    increasing `sequence` starting at 0.
   * 2. Reduce the events into a `RunResult` using the canonical
   *    semantics (`add_memory` → append, `set_state` → last-write-wins,
   *    `output` → merge-patch, `report` → concat, `log` → append).
   *
   * Optional — adapters that do not implement execution leave
   * this undefined and L4 cases skip.
   */
  runScripted?(
    bundle: LoadedBundle,
    context: ExecutionContext,
    scriptedEvents: readonly AfpsEvent[],
  ): Promise<RunScriptedOutput>;
}

export interface RunScriptedOutput {
  /** Envelopes the adapter emitted, in the order it emitted them. */
  emitted: readonly AfpsEventEnvelope[];
  /** Aggregated run result after reducing the events. */
  result: RunResult;
  /** Count of sink.finalize() invocations. MUST be exactly 1. */
  finalizeCalls: number;
}
