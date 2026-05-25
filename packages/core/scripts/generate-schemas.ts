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
import { afpsJsonSchemaOverride } from "@afps-spec/schema";
import { agentManifestSchema, skillManifestSchema } from "../src/validation.ts";
import { integrationManifestSchema } from "../src/integration.ts";
import { mcpServerManifestSchema } from "../src/mcp-server.ts";

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
    description: "Appstrate skill manifest — AFPS 2.0 skill with relaxed optional metadata.",
    schema: skillManifestSchema,
  },
  {
    filename: "mcp-server.schema.json",
    title: "Appstrate MCP-Server Manifest",
    description:
      'Appstrate mcp-server manifest — the canonical AFPS 2.0 / MCPB schema (re-exported from @afps-spec/schema). The AFPS identity contract under _meta["dev.afps/mcp-server"] is validated by the Zod superRefine and is not representable in JSON Schema.',
    schema: mcpServerManifestSchema,
  },
  {
    filename: "integration.schema.json",
    title: "Appstrate Integration Manifest",
    description:
      "Appstrate integration manifest — AFPS 2.0 (packages/core/src/integration.ts). Cross-field rules (≥1 auth, oauth2 discovery, delivery, scope-catalog subset, per-tool auth-key) are enforced by the Zod superRefines and are not representable in JSON Schema.",
    schema: integrationManifestSchema,
  },
];

// ─────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────

// Every schema is generated from its canonical Zod source: the base schemas
// come from @afps-spec/schema, with the Appstrate superRefines layered on top.
await Bun.$`mkdir -p ${OUTPUT_DIR}`.quiet();
for (const entry of appstrateSchemas) {
  await Bun.$`rm -f ${OUTPUT_DIR}/${entry.filename}`.quiet();
}

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
