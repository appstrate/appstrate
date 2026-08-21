// SPDX-License-Identifier: Apache-2.0

/**
 * `isCanonicalRunEvent` against the shared fixture corpus.
 *
 * The accept/reject cases live in `test/fixtures/canonical-event-corpus.ts`.
 * This file is their only reader since the generated JSON Schema documents
 * were removed (they were never published — see
 * `src/events/canonical-event-schemas.ts`), which makes the guard the sole
 * definition of the canonical payload shape and this suite the only thing
 * pinning it.
 */

import { describe, it, expect } from "bun:test";
import {
  CANONICAL_EVENT_CORPUS,
  NON_CANONICAL_EVENTS,
  NON_FINITE_DIVERGENCES,
} from "../fixtures/canonical-event-corpus.ts";
import type { RunEvent } from "@afps-spec/types";
import {
  CANONICAL_EVENT_TYPES,
  isCanonicalRunEvent,
  type CanonicalRunEvent,
} from "../../src/types/canonical-events.ts";

describe("isCanonicalRunEvent", () => {
  it("returns the corpus verdict for every canonical-typed fixture", () => {
    for (const { label, event, valid } of CANONICAL_EVENT_CORPUS) {
      expect({ label, verdict: isCanonicalRunEvent(event) }).toEqual({ label, verdict: valid });
    }
  });

  it("rejects event types outside the canonical vocabulary", () => {
    for (const { label, event } of NON_CANONICAL_EVENTS) {
      expect({ label, verdict: isCanonicalRunEvent(event) }).toEqual({ label, verdict: false });
    }
  });

  it("rejects non-finite numbers the wire cannot carry", () => {
    // See NON_FINITE_DIVERGENCES: `NaN` / `±Infinity` are `number`s in JS, so
    // a JSON-Schema validator accepts them in memory — but JSON cannot carry
    // them, so the serialized payload holds `null`. The guard rejects them up
    // front, which is why the stamped `dataschema` never contradicts the wire.
    for (const { label, event } of NON_FINITE_DIVERGENCES) {
      expect({ label, verdict: isCanonicalRunEvent(event) }).toEqual({ label, verdict: false });
    }
  });
});

describe("isCanonicalRunEvent — type-guard narrowing", () => {
  // The guard's declared predicate (`event is CanonicalRunEvent`) is what lets
  // `foldEvent`'s switch be exhaustively typed. Assert it here so a widening of
  // the return type is caught by this file and not only by the reducer.
  it("uses the discriminant for type narrowing in switch statements", () => {
    const event: RunEvent = {
      timestamp: 1,
      runId: "r1",
      type: "log.written",
      level: "warn",
      message: "x",
    };
    if (isCanonicalRunEvent(event) && event.type === "log.written") {
      // TypeScript narrowing — these accesses are typed.
      expect(event.level).toBe("warn");
      expect(event.message).toBe("x");
    } else {
      throw new Error("expected canonical narrowing");
    }
  });
});

describe("CANONICAL_EVENT_TYPES", () => {
  it("matches the union exhaustively (compile + runtime)", () => {
    // Compile-time: each entry must be a CanonicalRunEvent['type']
    const arr: ReadonlyArray<CanonicalRunEvent["type"]> = CANONICAL_EVENT_TYPES;
    // The one place the count is pinned to a literal: 4 reserved AFPS
    // namespaces (memory/pinned/output/log) + 3 appstrate.* platform-internal
    // events (progress/error/metric). Every other file derives from
    // `CANONICAL_EVENT_TYPES.length` so the literal has a single home.
    expect(arr.length).toBe(7);
    expect(new Set(arr).size).toBe(arr.length);
  });

  it("is exercised end to end by the shared corpus", () => {
    const covered = new Set(CANONICAL_EVENT_CORPUS.map((f) => f.event.type));
    expect([...covered].sort()).toEqual([...CANONICAL_EVENT_TYPES].sort());
  });
});
