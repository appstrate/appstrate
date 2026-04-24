// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "@afps/types";
import type { RunResult } from "../types/run-result.ts";

/**
 * Fan-out sink: broadcasts each `handle` / `finalize` call to all child
 * sinks in parallel. If any child rejects, the aggregated error surfaces
 * via `Promise.allSettled` after every sibling has had a chance to
 * complete — this keeps one flaky sink from cancelling persistence on
 * healthy ones.
 *
 * Example: stream events to a local `.jsonl` **and** to a remote HTTP
 * endpoint at the same time — no bespoke orchestration needed.
 */
export class CompositeSink implements EventSink {
  private readonly children: readonly EventSink[];

  constructor(children: readonly EventSink[]) {
    this.children = children;
  }

  async handle(event: RunEvent): Promise<void> {
    await this.runAll(
      this.children.map((c) => c.handle(event)),
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
