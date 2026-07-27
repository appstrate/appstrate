// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Drift guards for the published CloudEvent payload schemas.
 *
 * Four layers:
 *
 * 1. **Artifact parity** — the committed `schemas/v0/events/*.json` files
 *    must byte-equal a fresh generation from the Zod source. A
 *    hand-edited schema fails here.
 * 2. **JSON Schema validity** — every document compiles under ajv 2020-12.
 * 3. **Behavioral parity** — the shared fixture corpus in
 *    `test/fixtures/canonical-event-corpus.ts` must get its labelled
 *    verdict from the generated schemas. `test/types/canonical-events.test.ts`
 *    asserts the SAME label against `isCanonicalRunEvent`, so parity between
 *    the two implementations is structural, not restated here. This is the
 *    guard the compile-time assertions cannot give: the canonical interfaces
 *    carry `RunEvent`'s open index signature, so tsc cannot structurally
 *    diff them.
 * 4. **Coverage** — the set of constrained field paths is derived
 *    mechanically from the generated documents, and every one of them must
 *    be exercised by a wrong-typed fixture. Adding a constraint to a Zod
 *    schema fails the suite until the corpus catches up, so the corpus
 *    cannot silently go vacuous over a field again.
 */

import { describe, it, expect } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readdir } from "node:fs/promises";
import {
  CANONICAL_EVENT_CORPUS,
  NON_FINITE_DIVERGENCES,
} from "../fixtures/canonical-event-corpus.ts";
import {
  CANONICAL_EVENT_SCHEMAS,
  CANONICAL_EVENT_SCHEMA_VERSION,
  buildCanonicalEventJsonSchemas,
  canonicalEventSchemaUri,
  serializeCanonicalEventJsonSchema,
} from "../../src/events/canonical-event-schemas.ts";
import { buildCloudEventEnvelope } from "../../src/events/cloudevents.ts";
import { CANONICAL_EVENT_TYPES, type CanonicalRunEvent } from "../../src/types/canonical-events.ts";

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

const ajv = new Ajv2020({ strict: false });
const validators = new Map(
  buildCanonicalEventJsonSchemas().map((doc) => [
    doc.filename.replace(/\.schema\.json$/, ""),
    ajv.compile(doc.document),
  ]),
);

/**
 * Every field path in a generated document that carries a violable
 * constraint (`type` or `enum`), derived by walking `properties`
 * recursively. `pinned.set.content` and `output.emitted.data` are
 * deliberately absent: they are `z.unknown()`, so no value can violate
 * their type — only their `required`-ness, which the omission fixtures
 * cover.
 */
function constrainedPaths(node: unknown, prefix: string, out: Set<string>): void {
  if (typeof node !== "object" || node === null) return;
  const properties = (node as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null) return;
  for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof sub !== "object" || sub === null) continue;
    const subSchema = sub as Record<string, unknown>;
    if (subSchema.type !== undefined || subSchema.enum !== undefined) out.add(path);
    constrainedPaths(subSchema, path, out);
  }
}

describe("published schemas ↔ shared fixture corpus", () => {
  it("returns the corpus verdict for every fixture's data projection", () => {
    for (const { label, event, valid } of CANONICAL_EVENT_CORPUS) {
      const envelope = buildCloudEventEnvelope({ event, sequence: 1, id: "id" });
      const validate = validators.get(event.type)!;
      // `test/types/canonical-events.test.ts` asserts `isCanonicalRunEvent`
      // against this same `valid` label — asserting it again here would be
      // the same check twice. Parity is structural: one corpus, two readers.
      expect({ label, schemaVerdict: validate(envelope.data) }).toEqual({
        label,
        schemaVerdict: valid,
      });
    }
  });

  it("validates the data projection of a well-formed event of every type", () => {
    // Belt-and-braces: the accept half of the corpus, asserted per type so
    // a schema that silently accepts nothing is caught.
    for (const type of CANONICAL_EVENT_TYPES) {
      const accepted = CANONICAL_EVENT_CORPUS.filter((c) => c.event.type === type && c.valid);
      expect({ type, accepted: accepted.length > 0 }).toEqual({ type, accepted: true });
    }
  });

  it("exercises every constrained field the published schemas declare", () => {
    // The systematic half of the corpus guarantee. The expected set is not
    // hand-written: it is read off the generated documents, so a new Zod
    // constraint (a field, or a nested counter) fails here until a fixture
    // puts a wrong-typed value at that exact path. Without this, a corpus
    // can be large and still say nothing about a field — which is how
    // `durationMs`, `usage`'s inner counters, and `progress`/`error`'s
    // `data` went un-exercised while the guard silently disagreed with the
    // schema about all three.
    const missing: string[] = [];
    for (const doc of buildCanonicalEventJsonSchemas()) {
      const type = doc.filename.replace(/\.schema\.json$/, "");
      const paths = new Set<string>();
      constrainedPaths(doc.document, "", paths);
      const exercised = new Set(
        CANONICAL_EVENT_CORPUS.filter((f) => f.event.type === type && f.violates !== undefined).map(
          (f) => f.violates!,
        ),
      );
      for (const path of paths) if (!exercised.has(path)) missing.push(`${type}#${path}`);
      // The reverse direction: a fixture naming a path the schemas no
      // longer constrain is stale bookkeeping.
      for (const path of exercised) {
        if (!paths.has(path)) missing.push(`${type}#${path} (fixture names an unconstrained path)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("derives a non-trivial path set (the coverage guard is not vacuous)", () => {
    // Guards the guard: if `constrainedPaths` ever stopped finding
    // anything, the assertion above would pass unconditionally.
    const all = new Set<string>();
    for (const doc of buildCanonicalEventJsonSchemas()) constrainedPaths(doc.document, "", all);
    expect(all.has("usage.input_tokens")).toBe(true);
    expect(all.has("durationMs")).toBe(true);
    expect(all.size).toBeGreaterThanOrEqual(CANONICAL_EVENT_TYPES.length);
  });
});

describe("Number.isFinite divergence is documented, not accidental", () => {
  // The one place guard and schema legitimately disagree. `NaN` and
  // `±Infinity` are `number`s in JS, so ajv accepts them against
  // `{"type":"number"}` — but JSON cannot carry them, so the serialized
  // payload holds `null` and fails the very same schema. The guard rejects
  // them (asserted in `test/types/canonical-events.test.ts`); this file
  // asserts the other half, so the asymmetry stays a decision rather than
  // an oversight.
  it("ajv accepts in-memory non-finite numbers that JSON serialization destroys", () => {
    for (const { label, event } of NON_FINITE_DIVERGENCES) {
      const envelope = buildCloudEventEnvelope({ event, sequence: 1, id: "id" });
      const validate = validators.get(event.type)!;
      expect({ label, inMemory: validate(envelope.data) }).toEqual({ label, inMemory: true });
      // …and the same validator rejects what actually goes over the wire.
      expect({ label, onWire: validate(JSON.parse(JSON.stringify(envelope.data))) }).toEqual({
        label,
        onWire: false,
      });
    }
  });
});

describe("registry typing", () => {
  it("keys are exactly the CanonicalRunEvent discriminants", () => {
    // Compile-time: the registry is `satisfies Record<CanonicalRunEvent["type"], …>`,
    // so this assignment fails to build if a member is missing.
    const keys: ReadonlyArray<CanonicalRunEvent["type"]> = Object.keys(
      CANONICAL_EVENT_SCHEMAS,
    ) as Array<CanonicalRunEvent["type"]>;
    expect(keys).toHaveLength(CANONICAL_EVENT_TYPES.length);
  });
});
