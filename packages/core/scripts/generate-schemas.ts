// SPDX-License-Identifier: Apache-2.0

/**
 * Generate Appstrate JSON Schema files from the canonical AFPS JSON Schemas.
 *
 * Each file starts from the JSON Schema `@afps-spec/schema` publishes (`v0/*.schema.json`),
 * which carries the cross-field rules its generator writes in JSON Schema terms. Core's own
 * additions are the fields its Zod redefines on top of the AFPS Zod, converted to JSON Schema
 * Draft 2020-12; core's `superRefine` rules have no JSON Schema form and stay Zod-only.
 *
 * Usage: bun scripts/generate-schemas.ts
 */

import type { z } from "zod";
import { toJSONSchema } from "zod/v4/core";
import {
  afpsJsonSchemaOverride,
  agentManifestObjectSchema as afpsAgentManifestObjectSchema,
  integrationManifestSchema as afpsIntegrationManifestSchema,
  mcpServerManifestSchema as afpsMcpServerManifestSchema,
  skillManifestSchema as afpsSkillManifestSchema,
} from "@afps-spec/schema";
import { agentManifestSchema, skillManifestSchema } from "../src/validation.ts";
import { integrationManifestSchema } from "../src/integration.ts";
import { mcpServerManifestSchema } from "../src/mcp-server.ts";

// Bun-native pathing — `import.meta.dir` is the directory of this script.
const OUTPUT_DIR = `${import.meta.dir}/../schema`;

type ObjectSchema = z.ZodObject<z.ZodRawShape>;
type JsonSchema = Record<string, unknown> & {
  properties: Record<string, unknown>;
  required?: string[];
};

const appstrateSchemas: {
  filename: string;
  title: string;
  description: string;
  schema: ObjectSchema;
  afps: ObjectSchema;
}[] = [
  {
    filename: "agent.schema.json",
    title: "Appstrate Agent Manifest",
    description: "Appstrate agent manifest — extends AFPS agent.",
    schema: agentManifestSchema as unknown as ObjectSchema,
    afps: afpsAgentManifestObjectSchema as unknown as ObjectSchema,
  },
  {
    filename: "skill.schema.json",
    title: "Appstrate Skill Manifest",
    description: "Appstrate skill manifest — AFPS skill with relaxed optional metadata.",
    schema: skillManifestSchema as unknown as ObjectSchema,
    afps: afpsSkillManifestSchema as unknown as ObjectSchema,
  },
  {
    filename: "mcp-server.schema.json",
    title: "Appstrate MCP-Server Manifest",
    description:
      "Appstrate mcp-server manifest — the canonical AFPS / MCPB schema. The AFPS identity contract (type, name, schema_version, dependencies) lives at the manifest root (AFPS §3.4 / §11.2).",
    schema: mcpServerManifestSchema as unknown as ObjectSchema,
    afps: afpsMcpServerManifestSchema as unknown as ObjectSchema,
  },
  {
    filename: "integration.schema.json",
    title: "Appstrate Integration Manifest",
    description:
      "Appstrate integration manifest — the canonical AFPS schema. Appstrate's own rules (authorized_uris, delivery and scope-catalog policies, per-tool auth keys) are Zod refinements in packages/core/src/integration.ts, with no JSON Schema form.",
    schema: integrationManifestSchema as unknown as ObjectSchema,
    afps: afpsIntegrationManifestSchema as unknown as ObjectSchema,
  },
];

async function canonicalSchema(filename: string): Promise<JsonSchema> {
  const path = Bun.resolveSync(`@afps-spec/schema/v0/${filename}`, import.meta.dir);
  return (await Bun.file(path).json()) as JsonSchema;
}

/** The canonical schema with the fields core's Zod redefines replaced by their core form. */
function withAppstrateAdditions(
  canonical: JsonSchema,
  entry: (typeof appstrateSchemas)[number],
): JsonSchema {
  const redefined = Object.keys(entry.schema.shape).filter(
    (key) => entry.schema.shape[key] !== entry.afps.shape[key],
  );
  if (redefined.length === 0) return canonical;
  const core = toJSONSchema(entry.schema, {
    unrepresentable: "any",
    target: "draft-2020-12",
    override: afpsJsonSchemaOverride,
  }) as JsonSchema;
  const properties = { ...canonical.properties };
  for (const key of redefined) properties[key] = core.properties[key];
  const required = [
    ...(canonical.required ?? []).filter((key) => !redefined.includes(key)),
    ...(core.required ?? []).filter((key) => redefined.includes(key)),
  ];
  return { ...canonical, properties, required };
}

/** Every Appstrate schema file, as `generate:schemas` writes it and `schema-parity.test.ts` reads it. */
export async function buildAppstrateSchemas(): Promise<{ filename: string; schema: JsonSchema }[]> {
  return Promise.all(
    appstrateSchemas.map(async (entry) => {
      // Not the canonical document: its `$id`, title and description name the AFPS one.
      const {
        $id: _id,
        $schema,
        title: _title,
        description: _description,
        ...canonical
      } = withAppstrateAdditions(await canonicalSchema(entry.filename), entry);
      return {
        filename: entry.filename,
        schema: { $schema, title: entry.title, description: entry.description, ...canonical },
      };
    }),
  );
}

if (import.meta.main) {
  await Bun.$`mkdir -p ${OUTPUT_DIR}`.quiet();
  const built = await buildAppstrateSchemas();
  for (const { filename, schema } of built) {
    await Bun.write(`${OUTPUT_DIR}/${filename}`, JSON.stringify(schema, null, 2) + "\n");
    console.log(`  ✓ ${filename}`);
  }
  console.log(`\nGenerated ${built.length} schemas in ${OUTPUT_DIR}`);
}
