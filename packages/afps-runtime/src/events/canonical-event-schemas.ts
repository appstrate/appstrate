// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `dataschema` URIs for the canonical CloudEvent `data` payloads.
 *
 * {@link buildCloudEventEnvelope} builds `data` by subtracting the four
 * envelope keys (`type`, `timestamp`, `runId`, `toolCallId`) from the
 * {@link RunEvent} and shipping the rest; when the event is canonical it also
 * stamps the matching URI below as the optional CloudEvents `dataschema`
 * attribute. That stamping is wire behaviour and the only reason this module
 * exists.
 *
 * ## The URIs are identifiers, not files — and nothing serves them
 *
 * This module used to be the generator for a set of JSON Schema 2020-12
 * files: a Zod payload table, `buildCanonicalEventJsonSchema(s)`,
 * `serializeCanonicalEventJsonSchema`, seven committed artifacts under
 * `schemas/v0/events/`, a `schemas:generate` package script, and a
 * byte-compare drift test. All of it is gone. **Do not rebuild it without
 * first shipping the publication step**, because the artifacts were never
 * published:
 *
 *  - `https://schemas.afps.dev/v0/events/log.written.schema.json` → 404,
 *    while `https://schemas.afps.dev/v0/agent.schema.json` → 200 (verified
 *    2026-08). The afps-spec Pages job copies `packages/schema/v0/*.schema.json`
 *    flat, with no `events/` subdirectory, so nothing ever reached the host.
 *  - `schemas.appstrate.dev` — the intended vendor host for the `appstrate.*`
 *    files — was never stood up either.
 *  - `schemas:generate` was in no workflow, so the artifacts were regenerated
 *    only by hand.
 *
 * A `dataschema` URI is a stable identifier first and a fetchable file
 * second — CloudEvents 1.0 §3.1 does not require it to dereference, and
 * consumers are expected to treat a 404 as "schema not mirrored". Keeping the
 * URIs while dropping ~550 lines of unpublished generation machinery costs
 * nothing on the wire: the emitted attribute is byte-identical.
 *
 * The payload contract itself did not lose its only definition. The live
 * reader is `isCanonicalRunEvent` (`../types/canonical-events.ts`), which is
 * what actually gates the attribute, and it is exercised against the shared
 * fixture corpus in `test/fixtures/canonical-event-corpus.ts`. If the
 * files are ever genuinely wanted, regenerate from that guard — and wire
 * the Pages job in the same change.
 *
 * Specification: CloudEvents 1.0 §3.1 (`dataschema`).
 */

import type { CanonicalRunEvent } from "../types/canonical-events.ts";

/**
 * MAJOR of the payload contract, mirrored as the first path segment of every
 * URI — the same scheme `@afps-spec/schema` uses for the manifest schemas
 * (`https://schemas.afps.dev/v0/agent.schema.json`).
 *
 * A backwards-incompatible change to any canonical payload mints a new segment
 * (`v1/`) and leaves `v0/` frozen, so an already emitted `dataschema` URI never
 * silently changes meaning.
 */
export const CANONICAL_EVENT_SCHEMA_VERSION = "v0";

/**
 * Host for the four **AFPS-namespaced** events (`memory.*`, `pinned.*`,
 * `output.*`, `log.*`). These are reserved AFPS namespaces carried by
 * `@afps-spec/types`' {@link RunEvent}, so their identifiers belong on the
 * vendor-neutral spec host alongside the manifest schemas.
 */
const AFPS_EVENT_SCHEMA_BASE = `https://schemas.afps.dev/${CANONICAL_EVENT_SCHEMA_VERSION}/events`;

/**
 * Host for the `appstrate.*` events. These are **vendor** events emitted by
 * the Appstrate runner (lifecycle breadcrumbs, fatal errors, token metrics) —
 * not part of AFPS — so they are addressed under an Appstrate host rather than
 * squatting the neutral spec namespace, and stay distinct from
 * `docs.appstrate.dev`, which serves human-readable error documentation.
 */
const APPSTRATE_EVENT_SCHEMA_BASE = `https://schemas.appstrate.dev/${CANONICAL_EVENT_SCHEMA_VERSION}/events`;

/**
 * Every canonical event type → its `dataschema` URI.
 *
 * `satisfies Record<CanonicalRunEvent["type"], string>` is load-bearing:
 * adding a member to {@link CanonicalRunEvent} without a URI here is a compile
 * error, so the stamped surface cannot silently fall behind the union.
 */
export const CANONICAL_EVENT_SCHEMAS = {
  "memory.added": `${AFPS_EVENT_SCHEMA_BASE}/memory.added.schema.json`,
  "pinned.set": `${AFPS_EVENT_SCHEMA_BASE}/pinned.set.schema.json`,
  "output.emitted": `${AFPS_EVENT_SCHEMA_BASE}/output.emitted.schema.json`,
  "log.written": `${AFPS_EVENT_SCHEMA_BASE}/log.written.schema.json`,
  "appstrate.progress": `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.progress.schema.json`,
  "appstrate.error": `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.error.schema.json`,
  "appstrate.metric": `${APPSTRATE_EVENT_SCHEMA_BASE}/appstrate.metric.schema.json`,
} as const satisfies Record<CanonicalRunEvent["type"], string>;

/**
 * `dataschema` URI for a RunEvent type, or `undefined` when the type is not
 * canonical.
 *
 * Third-party (`@scope/tool.verb`) and retired types resolve to `undefined` on
 * purpose — the runtime cannot know their payload shape, and CloudEvents
 * `dataschema` is an assertion about `data`, not a decoration. Asserting a
 * schema we do not own would be a false claim, so the attribute is omitted
 * instead (it is OPTIONAL per CloudEvents 1.0 §3.1).
 */
export function canonicalEventSchemaUri(type: string): string | undefined {
  return Object.hasOwn(CANONICAL_EVENT_SCHEMAS, type)
    ? CANONICAL_EVENT_SCHEMAS[type as CanonicalRunEvent["type"]]
    : undefined;
}
