// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reference conformance adapter — thin glue between the suite and the
 * `@appstrate/afps-runtime` primitives. Third-party runners implement
 * the same {@link ConformanceAdapter} surface in their own language /
 * runtime.
 *
 * The L4 `runScripted` path replays the caller's `AfpsEvent[]` script
 * verbatim through a synthetic `EventSink`, converts each event to a
 * {@link RunEvent}, and reduces the stream into a {@link RunResult}
 * via {@link reduceRunEvents}. No runner class is involved — the suite
 * only validates the event / sink / reducer contract.
 */

import { loadBundleFromBuffer } from "../bundle/loader.ts";
import { verifyBundleSignature } from "../bundle/signing.ts";
import { renderPrompt } from "../bundle/prompt-renderer.ts";
import { SnapshotContextProvider } from "../providers/context/snapshot-provider.ts";
import { reduceRunEvents } from "../runner/run-event-reducer.ts";
import { toRunEvent } from "../types/run-event.ts";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "../types/run-event.ts";
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
    runScripted: async (_bundle, context, scriptedEvents): Promise<RunScriptedOutput> => {
      const emitted: RunEvent[] = [];
      let finalizeCalls = 0;
      const sink: EventSink = {
        handle: async (event) => {
          emitted.push(event);
        },
        finalize: async () => {
          finalizeCalls++;
        },
      };

      for (const event of scriptedEvents) {
        await sink.handle(toRunEvent({ event, runId: context.runId }));
      }
      const result: RunResult = reduceRunEvents(emitted);
      await sink.finalize(result);

      return { emitted, result, finalizeCalls };
    },
  };
}
