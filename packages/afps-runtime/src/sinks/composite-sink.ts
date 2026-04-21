// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { EventSink } from "../interfaces/event-sink.ts";
import type { AfpsEventEnvelope } from "../types/afps-event.ts";
import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Fan-out sink: broadcasts each `onEvent` / `handle` / `finalize` call
 * to all child sinks in parallel. If any child rejects, the aggregated
 * error surfaces via `Promise.allSettled` after every sibling has had a
 * chance to complete — this keeps one flaky sink from cancelling
 * persistence on healthy ones.
 *
 * Children that implement only the legacy `onEvent` (pre-1.3 AFPS
 * sinks) are invoked via `onEvent`; children that implement the new
 * `handle(RunEvent)` are invoked via `handle`. Both are called when
 * both are present, matching the runtime's emission contract.
 *
 * Example: stream events to a local `.jsonl` **and** to Appstrate over
 * HTTP at the same time — no bespoke orchestration needed.
 */
export class CompositeSink implements EventSink {
  private readonly children: readonly EventSink[];

  constructor(children: readonly EventSink[]) {
    this.children = children;
  }

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    await this.runAll(
      this.children.flatMap((c) => (c.onEvent ? [c.onEvent(envelope)] : [])),
      "onEvent",
    );
  }

  async handle(event: RunEvent): Promise<void> {
    await this.runAll(
      this.children.flatMap((c) => (c.handle ? [c.handle(event)] : [])),
      "handle",
    );
  }

  async finalize(result: RunResult): Promise<void> {
    await this.runAll(
      this.children.map((c) => c.finalize(result)),
      "finalize",
    );
  }

  private async runAll(promises: Promise<void>[], label: string): Promise<void> {
    const results = await Promise.allSettled(promises);
    const failures = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "rejected");

    if (failures.length > 0) {
      const reasons = failures
        .map(({ r, i }) => `child[${i}]: ${(r as PromiseRejectedResult).reason}`)
        .join("; ");
      throw new Error(`CompositeSink.${label} — ${failures.length} sink(s) failed: ${reasons}`);
    }
  }
}
