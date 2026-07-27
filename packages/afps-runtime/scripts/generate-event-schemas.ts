#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Generate the published JSON Schema documents for the canonical
 * CloudEvent `data` payloads.
 *
 * The Zod definitions in `src/events/canonical-event-schemas.ts` are the
 * source of truth; this script only writes their JSON projection to
 * `schemas/{version}/events/`. The committed files are what gets
 * published at the `$id` host, and `test/events/canonical-event-schemas.test.ts`
 * byte-compares them against a fresh generation — so a hand-edited
 * schema fails the suite.
 *
 * Usage:
 *   bun run schemas:generate    Write/update the JSON schemas
 */

import {
  CANONICAL_EVENT_SCHEMA_VERSION,
  buildCanonicalEventJsonSchemas,
  serializeCanonicalEventJsonSchema,
} from "../src/events/canonical-event-schemas.ts";

const OUTPUT_DIR = `${import.meta.dir}/../schemas/${CANONICAL_EVENT_SCHEMA_VERSION}/events`;

const documents = buildCanonicalEventJsonSchemas();

for (const doc of documents) {
  await Bun.write(`${OUTPUT_DIR}/${doc.filename}`, serializeCanonicalEventJsonSchema(doc));
  console.log(`  ✓ ${CANONICAL_EVENT_SCHEMA_VERSION}/events/${doc.filename}  →  ${doc.id}`);
}

console.log(`\nGenerated ${documents.length} event schemas in ${OUTPUT_DIR}`);
