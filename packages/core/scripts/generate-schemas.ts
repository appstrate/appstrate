/**
 * Generate Appstrate JSON Schema files from @afps-spec/schema Zod definitions.
 *
 * Imports the canonical AFPS Zod schemas and converts
 * to JSON Schema Draft 2020-12.
 *
 * Usage: bun scripts/generate-schemas.ts
 */

import { toJSONSchema } from "zod/v4/core";
import { resolve, dirname } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import {
  flowManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  providerManifestSchema,
} from "@afps-spec/schema";

const OUTPUT_DIR = resolve(dirname(import.meta.filename!), "../schema");

// ─────────────────────────────────────────────
// Extend AFPS schemas with Appstrate-specific fields
// ─────────────────────────────────────────────

// No Appstrate-specific extensions for now — all types use AFPS schemas directly
const appstrateSchemas = [
  {
    filename: "flow.schema.json",
    title: "Appstrate Flow Manifest",
    description: "Appstrate flow manifest — extends AFPS flow.",
    schema: flowManifestSchema,
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

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

for (const entry of appstrateSchemas) {
  const jsonSchema = toJSONSchema(entry.schema, {
    unrepresentable: "any",
    target: "draft-2020-12",
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;

  const final = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: entry.title,
    description: entry.description,
    ...jsonSchema,
  };

  const filePath = resolve(OUTPUT_DIR, entry.filename);
  await writeFile(filePath, JSON.stringify(final, null, 2) + "\n");
  console.log(`  ✓ ${entry.filename}`);
}

console.log(`\nGenerated ${appstrateSchemas.length} schemas in ${OUTPUT_DIR}`);
