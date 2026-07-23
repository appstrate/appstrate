// SPDX-License-Identifier: Apache-2.0

/**
 * RuntimeEventJournal — the authoritative, single-execution source of runtime
 * tool events for a run.
 *
 * The sidecar runs each runtime tool's handler exactly once (see
 * `journalRuntimeToolDefs`). The canonical events that handler produces
 * (`log.written`, `memory.added`, `pinned.set`,
 * `output.emitted`) are appended here, each stamped with a monotonic sequence.
 * The Pi runner DRAINs this journal over HTTP
 * (`GET /runtime-events?after=<cursor>`) and re-emits on its single run-event
 * sink. One execution, one source of truth, transport-agnostic — replacing the
 * older observe-replay (re-running the pure handler on observed args).
 *
 * Safe as in-memory mutable state because the sidecar is ONE process per run
 * (`server.ts` boots a single instance keyed on `RUN_ID`).
 */

import {
  reEmitRuntimeToolEvents,
  RUNTIME_TOOL_EVENTS_META_KEY,
  type RuntimeToolDef,
} from "@appstrate/core/runtime-tool-defs";
import { logger } from "./logger.ts";

/** A canonical run event as appended by a runtime-tool handler. */
export type JournalEvent = Record<string, unknown>;

interface Entry {
  seq: number;
  event: JournalEvent;
}

export interface JournalBatch {
  /** Events with sequence strictly greater than the requested cursor. */
  events: JournalEvent[];
  /** Highest sequence in the journal (the drainer's new cursor). */
  cursor: number;
  /** Smallest sequence still retained — lets the drainer detect FIFO eviction. */
  firstSeq: number;
}

/** Upper bound on retained entries; oldest are evicted FIFO past this. */
const DEFAULT_CAP = 10_000;

export class RuntimeEventJournal {
  private readonly entries: Entry[] = [];
  private next = 1;
  private readonly cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = cap;
  }

  /** Append one canonical event, assigning it the next monotonic sequence. */
  append(event: JournalEvent): void {
    this.entries.push({ seq: this.next, event });
    this.next += 1;
    if (this.entries.length > this.cap) {
      const evicted = this.entries.shift();
      // Loud, not silent: a runner draining slower than the agent emits would
      // otherwise lose events with no trace. In practice the cap is far above
      // any real run's event count.
      logger.warn("runtime_event_journal_evicted", {
        evictedSeq: evicted?.seq,
        cap: this.cap,
      });
    }
  }

  /**
   * Return every event appended after `cursor`, plus the new cursor and the
   * smallest sequence still retained (eviction signal). An empty journal or an
   * up-to-date cursor yields `events: []` with `cursor` unchanged.
   */
  after(cursor: number): JournalBatch {
    const events: JournalEvent[] = [];
    let highest = cursor;
    if (this.entries.length === 0) {
      return { events, cursor: highest, firstSeq: this.next };
    }
    const firstSeq = this.entries[0]!.seq;
    // Sequences are contiguous and monotonic: `append` always adds +1 and
    // eviction only shifts from the front, so `entries[i].seq === firstSeq + i`.
    // That lets us jump straight to the first not-yet-drained entry instead of
    // scanning the whole (up to 10k-entry) buffer on every poll.
    const startIndex = Math.max(0, cursor - firstSeq + 1);
    for (let i = startIndex; i < this.entries.length; i += 1) {
      const entry = this.entries[i]!;
      events.push(entry.event);
      if (entry.seq > highest) highest = entry.seq;
    }
    return { events, cursor: highest, firstSeq };
  }
}

/**
 * Wrap each runtime-tool def so its handler runs ONCE, journals the canonical
 * events it produced, and returns the tool result to the agent with ONLY the
 * events sub-key removed from `_meta`. The strip is defensive: it preserves any
 * other `_meta` key and keeps the `_meta` object itself, so a future runtime
 * tool that attaches additional `_meta` is unaffected. (Today only runtime-tool
 * defs are wrapped here — integration tools like `{ns}__api_call`, which carry
 * their own upstream `_meta`, pass through a different path and are never
 * wrapped — so no non-events `_meta` key reaches this code yet.)
 *
 * After this wrap the events ride exclusively through the journal → drain →
 * single-sink path: no runner reads `result._meta` for runtime tools anymore,
 * which also removes the run-event forgery vector that an `_meta` passthrough
 * would expose to an untrusted MCP transport.
 */
export function journalRuntimeToolDefs(
  defs: RuntimeToolDef[],
  journal: RuntimeEventJournal,
): RuntimeToolDef[] {
  return defs.map((def) => ({
    descriptor: def.descriptor,
    handler: async (rawArgs: unknown) => {
      const result = await def.handler(rawArgs);
      reEmitRuntimeToolEvents(result._meta, (event) => journal.append(event as JournalEvent));
      if (result._meta && RUNTIME_TOOL_EVENTS_META_KEY in result._meta) {
        const { [RUNTIME_TOOL_EVENTS_META_KEY]: _events, ...rest } = result._meta;
        return { ...result, _meta: rest };
      }
      return result;
    },
  }));
}
