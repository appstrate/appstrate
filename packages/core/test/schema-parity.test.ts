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
  const oauth2 = {
    type: "oauth2",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    default_scopes: ["read"],
    scope_catalog: [
      { value: "read", label: "Read" },
      { value: "write", label: "Write" },
    ],
    authorized_uris: ["https://api.example.com/**"],
    delivery: {
      http: {
        in: "header",
        name: "Authorization",
        prefix: "Bearer ",
        value: "{$credential.access_token}",
      },
    },
    _meta: { "dev.appstrate/oauth": { scope_separator: " " } },
  };
  const corpus: { label: string; manifest: Record<string, unknown>; valid: boolean }[] = [
    { label: "a public integration", manifest: base, valid: true },
    {
      label: "a public local-source integration",
      manifest: {
        ...base,
        source: { kind: "local", server: { name: "@acme/open-server", version: "^1.0.0" } },
      },
      valid: true,
    },
    {
      label: "a none source with an oauth2 auth, per-tool scopes and Appstrate _meta",
      manifest: {
        ...base,
        source: { kind: "none" },
        auths: { primary: oauth2 },
        default_tools: ["api_call"],
        tools_policy: { api_call: { required_scopes: { primary: ["write"] } } },
        _meta: { "dev.appstrate/api": { auths: { primary: { upload_protocols: ["tus"] } } } },
      },
      valid: true,
    },
    {
      label: "a remote URL and an api_key auth templated on a connection variable",
      manifest: {
        ...base,
        source: {
          kind: "remote",
          remote: { url: "{$variable.base_url}/mcp", transport: "streamable-http" },
        },
        variables: {
          schema: {
            type: "object",
            properties: { base_url: { type: "string", format: "uri" } },
            required: ["base_url"],
          },
        },
        auths: {
          key: {
            type: "api_key",
            credentials: {
              schema: {
                type: "object",
                properties: { api_key: { type: "string", writeOnly: true } },
                required: ["api_key"],
              },
            },
            authorized_uris: ["{$variable.base_url}/**"],
            delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
          },
        },
      },
      valid: true,
    },
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
