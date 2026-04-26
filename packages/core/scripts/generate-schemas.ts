// SPDX-License-Identifier: Apache-2.0

/**
 * Generate Appstrate JSON Schema files from @afps-spec/schema Zod definitions.
 *
 * Imports the canonical AFPS Zod schemas and converts
 * to JSON Schema Draft 2020-12.
 *
 * Usage: bun scripts/generate-schemas.ts
 */

import { toJSONSchema } from "zod/v4/core";
import {
  agentManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  providerManifestSchema,
  afpsJsonSchemaOverride,
} from "@afps-spec/schema";

// Bun-native pathing — `import.meta.dir` is the directory of this script.
const OUTPUT_DIR = `${import.meta.dir}/../schema`;

// ─────────────────────────────────────────────
// Extend AFPS schemas with Appstrate-specific fields
// ─────────────────────────────────────────────

// No Appstrate-specific extensions for now — all types use AFPS schemas directly
const appstrateSchemas = [
  {
    filename: "agent.schema.json",
    title: "Appstrate Agent Manifest",
    description: "Appstrate agent manifest — extends AFPS agent.",
    schema: agentManifestSchema,
  },
  {
    filename: "skill.schema.json",
    title: "Appstrate Skill Manifest",
    description: "Appstrate skill manifest — AFPS skill with no extensions.",
    schema: skillManifestSchema,
  },
  {
    filename: "tool.schema.json",
    title: "Appstrate Tool Manifest",
    description: "Appstrate tool manifest — AFPS tool with no extensions.",
    schema: toolManifestSchema,
  },
  {
    filename: "provider.schema.json",
    title: "Appstrate Provider Manifest",
    description: "Appstrate provider manifest — AFPS provider with no extensions.",
    schema: providerManifestSchema,
  },
];

// ─────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────

// Clear and recreate OUTPUT_DIR — Bun.$ shells out to /bin/rm + mkdir, so
// we use the standard $ template (Bun's recommended pathing primitive)
// instead of `node:fs/promises`.
await Bun.$`rm -rf ${OUTPUT_DIR}`.quiet();
await Bun.$`mkdir -p ${OUTPUT_DIR}`.quiet();

for (const entry of appstrateSchemas) {
  const jsonSchema = toJSONSchema(entry.schema, {
    unrepresentable: "any",
    target: "draft-2020-12",
    override: afpsJsonSchemaOverride,
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;

  const final = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: entry.title,
    description: entry.description,
    ...jsonSchema,
  };

  const filePath = `${OUTPUT_DIR}/${entry.filename}`;
  await Bun.write(filePath, JSON.stringify(final, null, 2) + "\n");
  console.log(`  ✓ ${entry.filename}`);
}

console.log(`\nGenerated ${appstrateSchemas.length} schemas in ${OUTPUT_DIR}`);
