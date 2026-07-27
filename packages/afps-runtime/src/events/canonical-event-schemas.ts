// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Published JSON Schema contracts for the canonical CloudEvent `data`
 * payloads.
 *
 * Why this exists: {@link buildCloudEventEnvelope} builds `data` by
 * subtracting the four envelope keys (`type`, `timestamp`, `runId`,
 * `toolCallId`) from the {@link RunEvent} and shipping the rest. Until
 * now, the resulting shapes were declared only as TypeScript interfaces
 * in `../types/canonical-events.ts` — so a Knative / Argo / generic
 * CloudEvents consumer had to read Appstrate TypeScript to learn what
 * `memory.added.data` contains.
 *
 * This module is the **single source of truth** for those payload
 * shapes. The Zod schemas below are:
 *
 * 1. converted to JSON Schema 2020-12 by
 *    {@link buildCanonicalEventJsonSchemas} and committed under
 *    `schemas/v0/events/` (regenerate with `bun run schemas:generate`);
 * 2. addressed by the stable `$id` URIs below, which
 *    {@link buildCloudEventEnvelope} emits as the optional CloudEvents
 *    `dataschema` attribute.
 *
 * Drift guards (see `test/events/canonical-event-schemas.test.ts`):
 *
 * - the committed JSON artifacts are byte-compared against a fresh
 *   generation, so a hand-edited schema fails the suite;
 * - {@link CANONICAL_EVENT_SCHEMAS} is `satisfies`-typed over
 *   {@link CanonicalRunEvent}'s discriminant, so adding a canonical
 *   event without a schema is a compile error;
 * - the `_…Parity` type aliases at the bottom of this file assert, at
 *   compile time, that an event assembled from a schema-inferred payload
 *   still satisfies its hand-written interface;
 * - a shared fixture corpus asserts the generated schemas agree with
 *   {@link isCanonicalRunEvent} on accept/reject.
 *
 * Publication status: the generated documents are committed here but the
 * `$id` hosts do not serve them yet — publishing
 * `schemas/{version}/events/*.json` to `schemas.afps.dev` (AFPS-namespaced
 * events) and `schemas.appstrate.dev` (`appstrate.*` vendor events) is a
 * separate, deliberate step. A `dataschema` URI is a stable identifier
 * first and a fetchable document second, which is why CloudEvents does
 * not require it to dereference; consumers that fetch it should treat a
 * 404 as "schema not yet mirrored", not as an invalid event.
 *
 * Specification: CloudEvents 1.0 §3.1 (`dataschema`), JSON Schema
 * 2020-12.
 */

import { z } from "zod";
import type { TokenUsage } from "@appstrate/afps-shared/token-usage";
import type {
  AppstrateErrorEvent,
  AppstrateMetricEvent,
  AppstrateProgressEvent,
  CanonicalRunEvent,
  LogWrittenEvent,
  MemoryAddedEvent,
  OutputEmittedEvent,
  PinnedSetEvent,
} from "../types/canonical-events.ts";

// ---------------------------------------------------------------------------
// Schema identity
// ---------------------------------------------------------------------------

/**
 * MAJOR of the published payload contract, mirrored as the first path
 * segment of every `$id` — the same scheme `@afps-spec/schema` uses for
 * the manifest schemas (`https://schemas.afps.dev/v0/agent.schema.json`).
 *
 * A backwards-incompatible change to ANY payload below mints a new
 * segment (`v1/`) and leaves the `v0/` documents frozen, so an already
 * emitted `dataschema` URI never silently changes meaning.
 */
export const CANONICAL_EVENT_SCHEMA_VERSION = "v0";

/**
 * Host for the four **AFPS-namespaced** events (`memory.*`, `pinned.*`,
 * `output.*`, `log.*`). These are reserved AFPS namespaces carried by
 * `@afps-spec/types`' {@link RunEvent}, so their schemas belong on the
 * vendor-neutral spec host alongside the manifest schemas.
 */
const AFPS_EVENT_SCHEMA_BASE = `https://schemas.afps.dev/${CANONICAL_EVENT_SCHEMA_VERSION}/events`;

/**
 * Host for the `appstrate.*` events. These are **vendor** events emitted
 * by the Appstrate runner (lifecycle breadcrumbs, fatal errors, token
 * metrics) — not part of AFPS — so they are addressed under an Appstrate
 * host rather than squatting the neutral spec namespace. The `schemas.`
 * subdomain mirrors `schemas.afps.dev` exactly (same GitHub Pages + CNAME
 * recipe) and stays distinct from `docs.appstrate.dev`, which serves
 * human-readable error documentation rather than machine-readable schema
 * documents.
 */
const APPSTRATE_EVENT_SCHEMA_BASE = `https://schemas.appstrate.dev/${CANONICAL_EVENT_SCHEMA_VERSION}/events`;

// ---------------------------------------------------------------------------
// Payload schemas — one per canonical event type
// ---------------------------------------------------------------------------

/** AFPS unified-persistence scope. Absent means `"actor"` (fail-safe isolation). */
const scopeSchema = z
  .enum(["actor", "shared"])
  .describe(
    'AFPS persistence scope. Absent MUST be read as "actor" (per-actor isolation), never as "shared".',
  );

/**
 * Token counters reported by the provider. Every field is optional —
 * wire reality is partial usage. Kept structurally identical to
 * {@link TokenUsage} (asserted below).
 */
const tokenUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

/**
 * Every payload is a LOOSE object: {@link RunEvent} is an open envelope
 * by design, so an emitter carrying extra keys is conformant and MUST
 * NOT be rejected by a downstream validator.
 */
const memoryAddedDataSchema = z.looseObject({
  content: z.string().describe("Archive entry appended to the run actor's memory."),
  scope: scopeSchema.optional(),
});

const pinnedSetDataSchema = z.looseObject({
  key: z
    .string()
    .min(1)
    .describe('Pinned slot identifier. "checkpoint" is reserved for the carry-over slot.'),
  content: z.unknown().describe("Arbitrary JSON value stored under the pinned slot."),
  scope: scopeSchema.optional(),
});

const outputEmittedDataSchema = z.looseObject({
  data: z.unknown().describe("Structured run output. Replace-on-emit — last write wins."),
});

const logWrittenDataSchema = z.looseObject({
  level: z.enum(["info", "warn", "error"]).describe("Severity of the log line."),
  message: z.string().describe("Human-readable log message."),
});

const appstrateProgressDataSchema = z.looseObject({
  message: z.string().describe("Lifecycle breadcrumb (container started, runtime ready, …)."),
  data: z.record(z.string(), z.unknown()).optional().describe("Structured breadcrumb context."),
});

const appstrateErrorDataSchema = z.looseObject({
  message: z.string().describe("Fatal runtime error observed before or after the LLM loop."),
  data: z.record(z.string(), z.unknown()).optional().describe("Structured error context."),
});

const appstrateMetricDataSchema = z.looseObject({
  usage: tokenUsageSchema.optional().describe("Cumulative token counters for the run so far."),
  cost: z.number().min(0).optional().describe("Cost in USD attributed to this segment."),
  durationMs: z.number().optional().describe("Wall-clock milliseconds covered by this metric."),
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CanonicalEventSchemaEntry {
  /**
   * Absolute, versioned schema identifier. Emitted verbatim as the
   * CloudEvents `dataschema` attribute and written as the `$id` of the
   * generated JSON Schema document.
   */
  id: string;
  /** Document title. */
  title: string;
  /** Document description. */
  description: string;
  /** Zod source of truth for the CloudEvent `data` payload. */
  schema: z.ZodType;
}

/**
 * Every canonical event type → its published payload contract.
 *
 * `satisfies Record<CanonicalRunEvent["type"], …>` is load-bearing:
 * adding a member to {@link CanonicalRunEvent} without a schema here is
 * a compile error, so the published surface cannot silently fall behind
 * the union.
 */
export const CANONICAL_EVENT_SCHEMAS = {
  "memory.added": {
    id: `${AFPS_EVENT_SCHEMA_BASE}/memory.added.schema.json`,
    title: "AFPS memory.added event data",
    description:
      "CloudEvent `data` payload for `memory.added` — an append-only archive write emitted by the AFPS `note()` tool (@afps/memory).",
    schema: memoryAddedDataSchema,
  },
  "pinned.set": {
    id: `${AFPS_EVENT_SCHEMA_BASE}/pinned.set.schema.json`,
    title: "AFPS pinned.set event data",
    description:
      "CloudEvent `data` payload for `pinned.set` — an upsert-by-key into a named pinned slot emitted by the AFPS `pin()` tool (@afps/pin). Last-write-wins per (scope, key).",
    schema: pinnedSetDataSchema,
  },
  "output.emitted": {
    id: `${AFPS_EVENT_SCHEMA_BASE}/output.emitted.schema.json`,
    title: "AFPS output.emitted event data",
    description:
      "CloudEvent `data` payload for `output.emitted` — the structured run output emitted by the AFPS `output()` tool (@afps/output).",
    schema: outputEmittedDataSchema,
  },
  "log.written": {
    id: `${AFPS_EVENT_SCHEMA_BASE}/log.written.schema.json`,
    title: "AFPS log.written event data",
    description:
      "CloudEvent `data` payload for `log.written` — a severity-tagged log line emitted by the AFPS `log()` tool (@afps/log).",
    schema: logWrittenDataSchema,
  },
  "appstrate.progress": {
    id: `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.progress.schema.json`,
    title: "Appstrate appstrate.progress event data",
    description:
      "CloudEvent `data` payload for `appstrate.progress` — a runner-emitted lifecycle breadcrumb. Vendor event, not part of AFPS.",
    schema: appstrateProgressDataSchema,
  },
  "appstrate.error": {
    id: `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.error.schema.json`,
    title: "Appstrate appstrate.error event data",
    description:
      "CloudEvent `data` payload for `appstrate.error` — a fatal runtime error raised outside the LLM loop. Vendor event, not part of AFPS.",
    schema: appstrateErrorDataSchema,
  },
  "appstrate.metric": {
    id: `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.metric.schema.json`,
    title: "Appstrate appstrate.metric event data",
    description:
      "CloudEvent `data` payload for `appstrate.metric` — cumulative token usage, cost, and duration reported by the runner. Vendor event, not part of AFPS.",
    schema: appstrateMetricDataSchema,
  },
} as const satisfies Record<CanonicalRunEvent["type"], CanonicalEventSchemaEntry>;

/**
 * `dataschema` URI for a RunEvent type, or `undefined` when the type is
 * not canonical.
 *
 * Third-party (`@scope/tool.verb`) and retired types resolve to
 * `undefined` on purpose — the runtime cannot know their payload shape,
 * and CloudEvents `dataschema` is an assertion about `data`, not a
 * decoration. Asserting a schema we do not own would be a false claim,
 * so the attribute is omitted instead (it is OPTIONAL per CloudEvents
 * 1.0 §3.1).
 */
export function canonicalEventSchemaUri(type: string): string | undefined {
  return Object.hasOwn(CANONICAL_EVENT_SCHEMAS, type)
    ? CANONICAL_EVENT_SCHEMAS[type as CanonicalRunEvent["type"]].id
    : undefined;
}

// ---------------------------------------------------------------------------
// JSON Schema generation
// ---------------------------------------------------------------------------

/** One generated JSON Schema document, ready to be written/published. */
export interface CanonicalEventJsonSchemaDocument {
  /** File name under `schemas/{version}/events/`. */
  filename: string;
  /** The document's `$id` — determines which host it must be published to. */
  id: string;
  /** JSON Schema 2020-12 document. */
  document: Record<string, unknown>;
}

/**
 * `z.object()` (strip mode) emits `additionalProperties: false`, but
 * stripping is a *parse-time* behavior, not a wire constraint: the
 * platform drops unknown token counters, it does not reject the event.
 * Publishing `additionalProperties: false` would make a JSON-Schema
 * validator reject payloads the platform accepts, so the constraint is
 * dropped from the generated document.
 *
 * Same rationale as `applyCrossFieldRules` in `@afps-spec/schema`'s
 * generator: the emitted JSON must describe the wire contract, not the
 * Zod runtime's convenience behaviors.
 */
function openObjects(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) openObjects(item);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const node = schema as Record<string, unknown>;
  if (node.additionalProperties === false) delete node.additionalProperties;
  for (const value of Object.values(node)) openObjects(value);
}

/** Generate the JSON Schema document for one canonical event type. */
export function buildCanonicalEventJsonSchema(
  type: CanonicalRunEvent["type"],
): CanonicalEventJsonSchemaDocument {
  const entry: CanonicalEventSchemaEntry = CANONICAL_EVENT_SCHEMAS[type];
  const converted = z.toJSONSchema(entry.schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;

  delete converted.$schema;
  openObjects(converted);

  return {
    filename: `${type}.schema.json`,
    id: entry.id,
    document: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: entry.id,
      $comment: "SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Appstrate",
      title: entry.title,
      description: entry.description,
      ...converted,
    },
  };
}

/** Generate every canonical payload schema, in registry order. */
export function buildCanonicalEventJsonSchemas(): CanonicalEventJsonSchemaDocument[] {
  return (Object.keys(CANONICAL_EVENT_SCHEMAS) as Array<CanonicalRunEvent["type"]>).map(
    buildCanonicalEventJsonSchema,
  );
}

/**
 * Serialized form written to `schemas/{version}/events/` — 2-space JSON
 * plus a trailing newline. The generator and the drift test share this
 * function so a formatting change cannot desynchronize them.
 */
export function serializeCanonicalEventJsonSchema(doc: CanonicalEventJsonSchemaDocument): string {
  return JSON.stringify(doc.document, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Compile-time drift guards
// ---------------------------------------------------------------------------

/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;

/** Envelope fields subtracted from the CloudEvent `data` payload. */
interface EnvelopeFields {
  timestamp: number;
  runId: string;
  toolCallId?: string;
}

/** A whole RunEvent reassembled from a schema-inferred `data` payload. */
type EventFrom<TType extends string, TSchema extends z.ZodType> = EnvelopeFields & {
  type: TType;
} & z.infer<TSchema>;

/**
 * A payload the schema accepts must still satisfy the hand-written
 * interface. Adding a required field to an interface (or changing a
 * field's type) without updating the schema above breaks compilation
 * here.
 *
 * Note the limit of this guard: the canonical interfaces carry
 * `RunEvent`'s open index signature (`[key: string]: unknown`), so a
 * field *removed* from an interface but kept in the schema stays
 * assignable. The interfaces cannot be structurally diffed for that
 * direction — the fixture corpus in
 * `test/events/canonical-event-schemas.test.ts` covers it behaviorally.
 *
 * The tuple is exported purely so the compiler keeps checking it — every
 * member is an {@link Assert} whose constraint fails on drift. It carries
 * no runtime value and is not re-exported from the package barrel.
 *
 * The last two members diff {@link TokenUsage} in BOTH directions: that
 * interface has no index signature, so a counter added to or removed from
 * either side breaks compilation.
 */
export type CanonicalEventSchemaParity = [
  Assert<
    EventFrom<"memory.added", typeof memoryAddedDataSchema> extends MemoryAddedEvent ? true : false
  >,
  Assert<EventFrom<"pinned.set", typeof pinnedSetDataSchema> extends PinnedSetEvent ? true : false>,
  Assert<
    EventFrom<"output.emitted", typeof outputEmittedDataSchema> extends OutputEmittedEvent
      ? true
      : false
  >,
  Assert<
    EventFrom<"log.written", typeof logWrittenDataSchema> extends LogWrittenEvent ? true : false
  >,
  Assert<
    EventFrom<
      "appstrate.progress",
      typeof appstrateProgressDataSchema
    > extends AppstrateProgressEvent
      ? true
      : false
  >,
  Assert<
    EventFrom<"appstrate.error", typeof appstrateErrorDataSchema> extends AppstrateErrorEvent
      ? true
      : false
  >,
  Assert<
    EventFrom<"appstrate.metric", typeof appstrateMetricDataSchema> extends AppstrateMetricEvent
      ? true
      : false
  >,
  Assert<z.infer<typeof tokenUsageSchema> extends TokenUsage ? true : false>,
  Assert<TokenUsage extends z.infer<typeof tokenUsageSchema> ? true : false>,
];
