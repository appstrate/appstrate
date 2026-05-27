// SPDX-License-Identifier: Apache-2.0

/**
 * Generated-artifact guard: every committed `schema/<type>.schema.json` ⇄ its
 * canonical Zod source.
 *
 * The canonical validators live in `src/validation.ts` (agent, skill),
 * `src/mcp-server.ts` (mcp-server), and `src/integration.ts` (integration). The
 * committed `schema/*.schema.json` files are the published `$schema` targets
 * (editor autocomplete / external tooling) and are GENERATED from those Zod
 * schemas by `scripts/generate-schemas.ts` — they are not hand-maintained. This
 * test fails if any committed file falls out of sync, i.e. someone changed a Zod
 * schema and forgot to re-run `generate:schemas`. (A stale mcp-server mirror that
 * slipped through review is exactly what prompted covering all four here, not
 * just integration.)
 *
 * Cross-field rules (≥1 auth, oauth2 discovery, per-auth `delivery`,
 * scope-catalog subset, per-tool auth-key, the mcp-server `_meta` identity)
 * live in the Zod `superRefine`s and are intentionally absent from the JSON
 * Schema — `toJSONSchema` cannot represent refinements. That is expected and is
 * why the JSON Schema is a looser (structural) projection.
 *
 * To fix a failure: `cd packages/core && bun run generate:schemas`. The entries
 * below mirror `scripts/generate-schemas.ts` exactly — keep them in sync.
 */

import { describe, it, expect } from "bun:test";
import { toJSONSchema } from "zod/v4/core";
import { afpsJsonSchemaOverride } from "@afps-spec/schema";
import { agentManifestSchema, skillManifestSchema } from "../src/validation.ts";
import { mcpServerManifestSchema } from "../src/mcp-server.ts";
import { integrationManifestSchema } from "../src/integration.ts";

// Mirror of scripts/generate-schemas.ts `appstrateSchemas`.
const entries = [
  {
    filename: "agent.schema.json",
    title: "Appstrate Agent Manifest",
    description: "Appstrate agent manifest — extends AFPS agent.",
    schema: agentManifestSchema,
  },
  {
    filename: "skill.schema.json",
    title: "Appstrate Skill Manifest",
    description: "Appstrate skill manifest — AFPS skill with relaxed optional metadata.",
    schema: skillManifestSchema,
  },
  {
    filename: "mcp-server.schema.json",
    title: "Appstrate MCP-Server Manifest",
    description:
      "Appstrate mcp-server manifest — the canonical AFPS / MCPB schema (re-exported from @afps-spec/schema). The AFPS identity contract (type, name, schema_version, dependencies) lives at the manifest root (AFPS §3.4 / §11.2).",
    schema: mcpServerManifestSchema,
  },
  {
    filename: "integration.schema.json",
    title: "Appstrate Integration Manifest",
    description:
      "Appstrate integration manifest — AFPS (packages/core/src/integration.ts). Cross-field rules (≥1 auth, oauth2 discovery, delivery, scope-catalog subset, per-tool auth-key) are enforced by the Zod superRefines and are not representable in JSON Schema.",
    schema: integrationManifestSchema,
  },
] as const;

describe("schema/*.schema.json are generated from the Zod schemas", () => {
  for (const entry of entries) {
    it(`${entry.filename} matches generate:schemas output (run \`bun run generate:schemas\` if this fails)`, async () => {
      const committed = JSON.parse(
        await Bun.file(`${import.meta.dir}/../schema/${entry.filename}`).text(),
      ) as Record<string, unknown>;

      const jsonSchema = toJSONSchema(entry.schema, {
        unrepresentable: "any",
        target: "draft-2020-12",
        override: afpsJsonSchemaOverride,
      }) as Record<string, unknown>;
      delete jsonSchema.$schema;

      const generated = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: entry.title,
        description: entry.description,
        ...jsonSchema,
      };

      expect(committed).toEqual(generated);
    });
  }
});
