// SPDX-License-Identifier: Apache-2.0

/**
 * `isCanonicalRunEvent` against the shared fixture corpus.
 *
 * The accept/reject cases live in `test/fixtures/canonical-event-corpus.ts`.
 * This file is their only reader since the generated JSON Schema documents
 * were removed (they were never published), which makes
 * `CANONICAL_CONSTRAINTS` the sole definition of the canonical payload shape
 * and this suite the only thing pinning it.
 *
 * The last suite here is the mechanical coverage guard: it derives the
 * constrained field paths from the constraint table and fails unless the
 * corpus contains a fixture that each one actually rejects. See issue #1184
 * for why the previous derivation (from the generated schema documents) could
 * not be kept.
 */

import { describe, it, expect } from "bun:test";
import {
  CANONICAL_EVENT_CORPUS,
  NON_CANONICAL_EVENTS,
  NON_FINITE_DIVERGENCES,
} from "../fixtures/canonical-event-corpus.ts";
import type { RunEvent } from "@afps-spec/types";
import {
  CANONICAL_CONSTRAINTS,
  CANONICAL_EVENT_TYPES,
  firstViolatedConstraint,
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
    // front rather than admitting a value the consumer will never see.
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

describe("constraint coverage", () => {
  /** `<event type>:<field path>` for every constraint the guard enforces. */
  function constraintKeys(): string[] {
    return Object.entries(CANONICAL_CONSTRAINTS).flatMap(([type, constraints]) =>
      constraints.map((c) => `${type}:${c.path}`),
    );
  }

  it("has a fixture that each constraint is the one to reject", () => {
    // The property: for every constraint, some fixture in the corpus is
    // rejected *because of that constraint specifically*. Not "a fixture
    // mentions it" — a fixture where flipping that predicate is what changes
    // the verdict.
    //
    // Both the constraint set and the exercised set are derived: nothing here
    // is a hand-maintained list, which is the whole point. Adding a constraint
    // to `CANONICAL_CONSTRAINTS` without adding a fixture that violates it
    // fails this test, and the failure names the missing path.
    const exercised = new Set(
      [...CANONICAL_EVENT_CORPUS, ...NON_FINITE_DIVERGENCES]
        .filter((f) => !("valid" in f) || !f.valid)
        .map((f) => {
          const path = firstViolatedConstraint(f.event);
          return path === undefined ? undefined : `${f.event.type}:${path}`;
        })
        .filter((key): key is string => key !== undefined),
    );

    const unexercised = constraintKeys().filter((key) => !exercised.has(key));
    expect(unexercised).toEqual([]);
  });

  it("derives its constraints from every canonical type", () => {
    // A type added to the union with no constraints at all would make the
    // coverage assertion above vacuously true for it.
    expect(Object.keys(CANONICAL_CONSTRAINTS).sort()).toEqual([...CANONICAL_EVENT_TYPES].sort());
    for (const [type, constraints] of Object.entries(CANONICAL_CONSTRAINTS)) {
      expect({ type, hasConstraints: constraints.length > 0 }).toEqual({
        type,
        hasConstraints: true,
      });
    }
  });

  it("names each constrained path once per type", () => {
    for (const [type, constraints] of Object.entries(CANONICAL_CONSTRAINTS)) {
      const paths = constraints.map((c) => c.path);
      expect({ type, unique: new Set(paths).size }).toEqual({ type, unique: paths.length });
    }
  });

  it("declares a parent object path before any path that reads through it", () => {
    // Order is semantic: `usage.<counter>` assumes `usage` already passed.
    // A child declared first would read through an unvalidated value and the
    // "which constraint rejected this" attribution would shift.
    for (const [type, constraints] of Object.entries(CANONICAL_CONSTRAINTS)) {
      const seen = new Set<string>();
      for (const { path } of constraints) {
        const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : undefined;
        if (parent !== undefined) {
          expect({ type, path, parentDeclaredFirst: seen.has(parent) }).toEqual({
            type,
            path,
            parentDeclaredFirst: true,
          });
        }
        seen.add(path);
      }
    }
  });
});
