// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The canonical `dataschema` URI map.
 *
 * This suite used to be four layers deep — artifact byte-parity, JSON Schema
 * 2020-12 validity under ajv, behavioral parity between the generated schemas
 * and the fixture corpus, and a coverage guard that derived the constrained
 * field paths from the generated files. All four read the JSON Schema
 * artifacts that `schemas:generate` produced, and those artifacts were never
 * published (see `src/events/canonical-event-schemas.ts` for the 404 evidence),
 * so they went with the generator.
 *
 * What survives here is the part that is wire behaviour: the URI stamped as
 * the CloudEvents `dataschema` attribute must be stable, versioned, and
 * present for exactly the canonical types. The payload *shape* is asserted
 * against `isCanonicalRunEvent` in `test/types/canonical-events.test.ts` — the
 * implementation that actually gates the attribute.
 */

import { describe, it, expect } from "bun:test";
import {
  CANONICAL_EVENT_SCHEMAS,
  CANONICAL_EVENT_SCHEMA_VERSION,
  canonicalEventSchemaUri,
} from "../../src/events/canonical-event-schemas.ts";
import { CANONICAL_EVENT_TYPES, type CanonicalRunEvent } from "../../src/types/canonical-events.ts";

describe("canonical event schema registry", () => {
  it("covers every canonical event type, and only those", () => {
    expect(Object.keys(CANONICAL_EVENT_SCHEMAS).sort()).toEqual([...CANONICAL_EVENT_TYPES].sort());
  });

  it("addresses AFPS events on the spec host and appstrate.* on the vendor host", () => {
    // AFPS-namespaced events are part of the vendor-neutral RunEvent
    // contract; `appstrate.*` are Appstrate-only and must not squat the
    // spec namespace.
    for (const type of ["memory.added", "pinned.set", "output.emitted", "log.written"] as const) {
      expect(canonicalEventSchemaUri(type)).toBe(
        `https://schemas.afps.dev/v0/events/${type}.schema.json`,
      );
    }
    for (const type of ["appstrate.progress", "appstrate.error", "appstrate.metric"] as const) {
      expect(canonicalEventSchemaUri(type)).toBe(
        `https://schemas.appstrate.dev/v0/events/${type}.schema.json`,
      );
    }
  });

  it("returns no URI for third-party or retired event types", () => {
    expect(canonicalEventSchemaUri("@my-org/audit.logged")).toBeUndefined();
    expect(canonicalEventSchemaUri("report.appended")).toBeUndefined();
    expect(canonicalEventSchemaUri("constructor")).toBeUndefined();
  });

  it("versions every URI so a future shape change cannot redefine v0", () => {
    for (const uri of Object.values(CANONICAL_EVENT_SCHEMAS)) {
      expect(uri).toContain(`/${CANONICAL_EVENT_SCHEMA_VERSION}/events/`);
    }
  });
});

describe("registry typing", () => {
  it("keys are exactly the CanonicalRunEvent discriminants", () => {
    // Compile-time: the registry is `satisfies Record<CanonicalRunEvent["type"], string>`,
    // so this assignment fails to build if a member is missing.
    const keys: ReadonlyArray<CanonicalRunEvent["type"]> = Object.keys(
      CANONICAL_EVENT_SCHEMAS,
    ) as Array<CanonicalRunEvent["type"]>;
    expect(keys).toHaveLength(CANONICAL_EVENT_TYPES.length);
  });
});
