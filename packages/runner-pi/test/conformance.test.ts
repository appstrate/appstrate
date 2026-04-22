// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS L4 conformance — drives the standard execution-contract cases
 * against PiRunner via a scripted adapter. Proves that the Runner
 * honours:
 *
 *   - L4.1 — emits every scripted event in arrival order
 *   - L4.2 — calls sink.finalize() exactly once
 *   - L4.3 — reducer semantics (memories append, state LWW, etc.)
 *   - L4.4 — empty script → no emission, still finalizes
 *
 * The adapter bypasses the Pi SDK by driving a {@link ScriptedPiRunner}
 * which emits raw RunEvents directly through the internal sink —
 * bypassing the Pi → RunEvent translation layer. The bridge is covered
 * by session-bridge.test.ts; this suite covers the Runner orchestration
 * proper, aligned with the reference contract.
 */

import { describe, it, expect } from "bun:test";
import {
  runConformance,
  createDefaultAdapter,
  type ConformanceAdapter,
  type RunScriptedOutput,
} from "@appstrate/afps-runtime/conformance";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import { PiRunner } from "../src/pi-runner.ts";
import type { InternalSink } from "../src/pi-runner.ts";
import { createCaptureSink, makeBundlePackage, makeTestBundle } from "./helpers.ts";

/**
 * Adapter subclass that routes raw scripted RunEvents straight through
 * the bridge-compatible internal sink. We do NOT drive Pi SDK events —
 * the conformance suite tests the Runner's orchestration (emit order,
 * finalize exactly once, reducer), not the bridge's translation.
 */
class ScriptedEventRunner extends PiRunner {
  constructor(private readonly scripted: readonly RunEvent[]) {
    super({
      model: {
        id: "test-model",
        name: "test-model",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      systemPrompt: "conformance",
    });
  }

  protected override async executeSession(
    _context: ExecutionContext,
    internalSink: InternalSink,
    _signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const event of this.scripted) {
      await internalSink.emit(event);
    }
  }
}

/** Build an adapter that delegates to the reference one for L1/L2/L3 and drives PiRunner for L4. */
function makePiConformanceAdapter(): ConformanceAdapter {
  const baseline = createDefaultAdapter();
  return {
    name: "pi-runner",
    loadBundle: baseline.loadBundle.bind(baseline),
    renderPrompt: baseline.renderPrompt.bind(baseline),
    verifySignature: baseline.verifySignature.bind(baseline),
    async runScripted(
      _bundle: LoadedBundle,
      context: ExecutionContext,
      scriptedEvents: readonly RunEvent[],
    ): Promise<RunScriptedOutput> {
      const sink = createCaptureSink();
      const runner = new ScriptedEventRunner(scriptedEvents);
      // The scripted runner never touches `bundle` — pass a minimal
      // spec Bundle to satisfy the type contract.
      const specBundle = makeTestBundle(
        makeBundlePackage("@afps/conformance", "1.0.0", "agent", {}),
      );
      await runner.run({
        bundle: specBundle,
        context,
        providerResolver: { resolve: async () => [] },
        eventSink: sink,
      });
      if (!sink.finalized) {
        throw new Error("adapter invariant violated: finalize was not called");
      }
      return {
        emitted: sink.events,
        result: sink.finalized,
        finalizeCalls: sink.finalizeCalls,
      };
    },
  };
}

describe("PiRunner — AFPS L4 conformance", () => {
  it("passes all L4 cases", async () => {
    const adapter = makePiConformanceAdapter();
    const report = await runConformance(adapter, { levels: ["L4"] });

    expect(report.summary.failed).toBe(0);
    expect(report.summary.total).toBeGreaterThan(0);

    // Every case must PASS (never skipped — adapter implements runScripted)
    for (const c of report.cases) {
      if (c.status !== "pass") {
        throw new Error(
          `Conformance case ${c.id} (${c.title}) status=${c.status}: ${c.detail ?? "(no detail)"}`,
        );
      }
    }
  });
});
