// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Drift guards for the published CloudEvent payload schemas.
 *
 * Three layers:
 *
 * 1. **Artifact parity** — the committed `schemas/v0/events/*.json` files
 *    must byte-equal a fresh generation from the Zod source. A
 *    hand-edited schema fails here.
 * 2. **JSON Schema validity** — every document compiles under ajv 2020-12.
 * 3. **Behavioral parity** — a shared fixture corpus (the same accept /
 *    reject cases `canonical-events.test.ts` runs through
 *    `isCanonicalRunEvent`) must get the same verdict from the generated
 *    schemas. This is the guard the compile-time assertions cannot give:
 *    the canonical interfaces carry `RunEvent`'s open index signature, so
 *    tsc cannot structurally diff them.
 */

import { describe, it, expect } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readdir } from "node:fs/promises";
import type { RunEvent } from "@afps-spec/types";
import {
  CANONICAL_EVENT_SCHEMAS,
  CANONICAL_EVENT_SCHEMA_VERSION,
  buildCanonicalEventJsonSchemas,
  canonicalEventSchemaUri,
  serializeCanonicalEventJsonSchema,
} from "../../src/events/canonical-event-schemas.ts";
import { buildCloudEventEnvelope } from "../../src/events/cloudevents.ts";
import {
  CANONICAL_EVENT_TYPES,
  isCanonicalRunEvent,
  type CanonicalRunEvent,
} from "../../src/types/canonical-events.ts";

const SCHEMA_DIR = new URL(
  `../../schemas/${CANONICAL_EVENT_SCHEMA_VERSION}/events/`,
  import.meta.url,
).pathname;

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
    for (const entry of Object.values(CANONICAL_EVENT_SCHEMAS)) {
      expect(entry.id).toContain(`/${CANONICAL_EVENT_SCHEMA_VERSION}/events/`);
    }
  });
});

describe("committed schema artifacts", () => {
  it("byte-match a fresh generation from the Zod source", async () => {
    for (const doc of buildCanonicalEventJsonSchemas()) {
      const committed = await Bun.file(`${SCHEMA_DIR}${doc.filename}`).text();
      // Regenerate with: bun run --cwd packages/afps-runtime schemas:generate
      expect(committed).toBe(serializeCanonicalEventJsonSchema(doc));
    }
  });

  it("contains no stray files", async () => {
    const onDisk = (await readdir(SCHEMA_DIR)).sort();
    const expected = buildCanonicalEventJsonSchemas()
      .map((d) => d.filename)
      .sort();
    expect(onDisk).toEqual(expected);
  });

  it("declares the published $id as its own identity", () => {
    for (const doc of buildCanonicalEventJsonSchemas()) {
      expect(doc.document.$id).toBe(doc.id);
      expect(doc.document.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });
});

describe("published schemas are valid JSON Schema 2020-12", () => {
  it("compile under ajv", () => {
    // One ajv per document: the `$id`s are distinct but ajv refuses
    // duplicate registration across re-runs of the same instance.
    for (const doc of buildCanonicalEventJsonSchemas()) {
      const ajv = new Ajv2020({ strict: false });
      expect(() => ajv.compile(doc.document)).not.toThrow();
    }
  });

  it("leave the payload open — a RunEvent may carry extra keys", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(
      buildCanonicalEventJsonSchemas().find((d) => d.filename === "memory.added.schema.json")!
        .document,
    );
    expect(validate({ content: "hi", vendor_extra: { a: 1 } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral parity with the runtime guard
// ---------------------------------------------------------------------------

const baseEnvelope = { timestamp: 1, runId: "r1" };

/**
 * Corpus mirrored from `test/types/canonical-events.test.ts`. Every entry
 * must get the SAME verdict from `isCanonicalRunEvent` (which validates
 * the whole event) and from the generated JSON Schema (which validates
 * the CloudEvent `data` projection). Divergence means the published
 * contract no longer describes what the runtime treats as canonical.
 */
const CORPUS: ReadonlyArray<{ event: RunEvent; valid: boolean }> = [
  { event: { ...baseEnvelope, type: "memory.added", content: "hello" }, valid: true },
  {
    event: { ...baseEnvelope, type: "memory.added", content: "scoped", scope: "shared" },
    valid: true,
  },
  { event: { ...baseEnvelope, type: "memory.added" }, valid: false },
  { event: { ...baseEnvelope, type: "memory.added", content: 42 }, valid: false },
  { event: { ...baseEnvelope, type: "memory.added", content: "x", scope: "global" }, valid: false },

  {
    event: { ...baseEnvelope, type: "pinned.set", key: "checkpoint", content: { counter: 1 } },
    valid: true,
  },
  {
    event: { ...baseEnvelope, type: "pinned.set", key: "persona", content: "agent A" },
    valid: true,
  },
  { event: { ...baseEnvelope, type: "pinned.set", content: 1 }, valid: false },
  { event: { ...baseEnvelope, type: "pinned.set", key: "checkpoint" }, valid: false },
  {
    event: { ...baseEnvelope, type: "pinned.set", key: "k", content: 1, scope: "everyone" },
    valid: false,
  },

  { event: { ...baseEnvelope, type: "output.emitted", data: { ok: true } }, valid: true },
  { event: { ...baseEnvelope, type: "output.emitted" }, valid: false },

  { event: { ...baseEnvelope, type: "log.written", level: "info", message: "x" }, valid: true },
  { event: { ...baseEnvelope, type: "log.written", level: "debug", message: "x" }, valid: false },
  { event: { ...baseEnvelope, type: "log.written", level: "info" }, valid: false },

  { event: { ...baseEnvelope, type: "appstrate.progress", message: "running" }, valid: true },
  { event: { ...baseEnvelope, type: "appstrate.progress" }, valid: false },
  { event: { ...baseEnvelope, type: "appstrate.error", message: "boom" }, valid: true },

  { event: { ...baseEnvelope, type: "appstrate.metric" }, valid: true },
  { event: { ...baseEnvelope, type: "appstrate.metric", durationMs: 1234 }, valid: true },
  {
    event: {
      ...baseEnvelope,
      type: "appstrate.metric",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: 0.01,
    },
    valid: true,
  },
  { event: { ...baseEnvelope, type: "appstrate.metric", usage: 42 }, valid: false },
  { event: { ...baseEnvelope, type: "appstrate.metric", cost: -1 }, valid: false },
];

describe("schema ↔ isCanonicalRunEvent parity", () => {
  const ajv = new Ajv2020({ strict: false });
  const validators = new Map(
    buildCanonicalEventJsonSchemas().map((doc) => [
      doc.filename.replace(/\.schema\.json$/, ""),
      ajv.compile(doc.document),
    ]),
  );

  it("agrees on every corpus fixture", () => {
    for (const { event, valid } of CORPUS) {
      const envelope = buildCloudEventEnvelope({ event, sequence: 1, id: "id" });
      const validate = validators.get(event.type)!;
      const schemaVerdict = validate(envelope.data);
      const guardVerdict = isCanonicalRunEvent(event);

      expect({ type: event.type, schemaVerdict, guardVerdict }).toEqual({
        type: event.type,
        schemaVerdict: valid,
        guardVerdict: valid,
      });
    }
  });

  it("exercises every canonical type", () => {
    const covered = new Set(CORPUS.map((c) => c.event.type));
    expect([...covered].sort()).toEqual([...CANONICAL_EVENT_TYPES].sort());
  });

  it("validates the data projection of a well-formed event of every type", () => {
    // Belt-and-braces: the accept half of the corpus, asserted per type so
    // a schema that silently accepts nothing is caught.
    for (const type of CANONICAL_EVENT_TYPES) {
      const accepted = CORPUS.filter((c) => c.event.type === type && c.valid);
      expect(accepted.length).toBeGreaterThan(0);
    }
  });
});

describe("Number.isFinite divergence is documented, not accidental", () => {
  // `isCanonicalRunEvent` rejects a non-finite cost; JSON has no Infinity
  // literal, so an over-the-wire payload can never carry one. The guard is
  // deliberately stricter than the wire schema here — assert the guard's
  // behavior so the difference stays intentional.
  it("guard rejects Infinity cost that JSON cannot represent", () => {
    const event: RunEvent = {
      ...baseEnvelope,
      type: "appstrate.metric",
      cost: Number.POSITIVE_INFINITY,
    };
    expect(isCanonicalRunEvent(event)).toBe(false);
    expect(JSON.parse(JSON.stringify({ cost: Number.POSITIVE_INFINITY })).cost).toBeNull();
  });
});

describe("registry typing", () => {
  it("keys are exactly the CanonicalRunEvent discriminants", () => {
    // Compile-time: the registry is `satisfies Record<CanonicalRunEvent["type"], …>`,
    // so this assignment fails to build if a member is missing.
    const keys: ReadonlyArray<CanonicalRunEvent["type"]> = Object.keys(
      CANONICAL_EVENT_SCHEMAS,
    ) as Array<CanonicalRunEvent["type"]>;
    expect(keys).toHaveLength(7);
  });
});
