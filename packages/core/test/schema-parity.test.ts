// SPDX-License-Identifier: Apache-2.0

/**
 * Generated-artifact guard for `schema/<type>.schema.json`, the published `$schema` targets the
 * editor validates against while the API validates against the Zod schemas.
 *
 * 1. Every committed file is what `scripts/generate-schemas.ts` builds (fix: `cd packages/core &&
 *    bun run generate:schemas`).
 * 2. On the rules both can express, the integration JSON Schema and its Zod schema agree: a JSON
 *    regenerated from Zod alone drops the cross-field rules AFPS writes into its own JSON.
 */

import { describe, it, expect } from "bun:test";
import { createAjv } from "../src/ajv.ts";
import { buildAppstrateSchemas } from "../scripts/generate-schemas.ts";
import { integrationManifestSchema } from "../src/integration.ts";
import integrationJsonSchema from "../schema/integration.schema.json";

describe("schema/*.schema.json are generated", () => {
  it("matches generate:schemas output (run `bun run generate:schemas` if this fails)", async () => {
    for (const { filename, schema } of await buildAppstrateSchemas()) {
      const committed = (await Bun.file(`${import.meta.dir}/../schema/${filename}`).json()) as
        Record<string, unknown> | undefined;
      expect({ filename, schema: committed }).toEqual({ filename, schema });
    }
  });
});

describe("integration JSON Schema ⇄ Zod parity", () => {
  const validateJson = createAjv().compile(integrationJsonSchema);

  const base = {
    type: "integration",
    schema_version: "0.3",
    name: "@acme/open",
    version: "1.0.0",
    display_name: "Open",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.example.com/mcp", transport: "streamable-http" },
    },
  };
  const corpus: { label: string; manifest: Record<string, unknown>; valid: boolean }[] = [
    { label: "a public integration", manifest: base, valid: true },
    { label: "an empty auths map", manifest: { ...base, auths: {} }, valid: false },
    {
      label: "a none source without auths",
      manifest: { ...base, source: { kind: "none" } },
      valid: false,
    },
    {
      label: "required_scopes without auths",
      manifest: { ...base, tools_policy: { search: { required_scopes: { primary: ["read"] } } } },
      valid: false,
    },
  ];

  for (const { label, manifest, valid } of corpus) {
    it(`${valid ? "accepts" : "refuses"} ${label} on both sides`, () => {
      expect({
        json: validateJson(manifest),
        zod: integrationManifestSchema.safeParse(manifest).success,
      }).toEqual({ json: valid, zod: valid });
    });
  }
});
