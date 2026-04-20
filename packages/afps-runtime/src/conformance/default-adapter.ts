// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reference conformance adapter — thin glue between the suite and
 * the `@appstrate/afps-runtime` primitives. Third-party runners
 * implement the same {@link ConformanceAdapter} surface in their own
 * language / runtime.
 */

import { loadBundleFromBuffer } from "../bundle/loader.ts";
import { verifyBundleSignature } from "../bundle/signing.ts";
import { renderPrompt } from "../bundle/prompt-renderer.ts";
import { SnapshotContextProvider } from "../providers/context/snapshot-provider.ts";
import { MockRunner } from "../runner/mock.ts";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunResult } from "../types/run-result.ts";
import type { ConformanceAdapter, RunScriptedOutput } from "./adapter.ts";

export function createDefaultAdapter(): ConformanceAdapter {
  return {
    name: "@appstrate/afps-runtime",
    loadBundle: (bytes) => loadBundleFromBuffer(bytes),
    renderPrompt: (template, context, snapshot) => {
      const provider = new SnapshotContextProvider(snapshot);
      return renderPrompt({ template, context, provider });
    },
    verifySignature: (canonicalBytes, signatureDoc, trustRoot) =>
      verifyBundleSignature(canonicalBytes, signatureDoc, trustRoot),
    runScripted: async (bundle, context, scriptedEvents): Promise<RunScriptedOutput> => {
      const emitted: AfpsEventEnvelope[] = [];
      let finalizeCalls = 0;
      const sink: EventSink = {
        onEvent: async (env) => {
          emitted.push(env);
        },
        finalize: async () => {
          finalizeCalls++;
        },
      };
      const runner = new MockRunner({ events: [...scriptedEvents] });
      const result: RunResult = await runner.run({
        bundle,
        context,
        sink,
        contextProvider: new SnapshotContextProvider(),
      });
      return { emitted, result, finalizeCalls };
    },
  };
}
