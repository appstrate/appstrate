// SPDX-License-Identifier: Apache-2.0

/**
 * Generated-artifact guard: `schema/integration.schema.json` ⇄ Zod
 * `integrationManifestSchema`.
 *
 * The canonical validator for integration manifests is the Zod schema in
 * `src/integration.ts`. The committed `schema/integration.schema.json` is the
 * published `$schema` target (editor autocomplete / external tooling) and is
 * GENERATED from that Zod schema by `scripts/generate-schemas.ts` — it is not
 * hand-maintained. This test fails if the committed file falls out of sync,
 * i.e. someone changed the Zod schema and forgot to re-run `generate:schemas`.
 *
 * Cross-field rules (`server || apiCall`, per-auth `delivery`, scope-catalog
 * checks) live in the Zod `superRefine`s and are intentionally absent from the
 * JSON Schema — `toJSONSchema` cannot represent refinements. That is expected
 * and is why the JSON Schema is a looser (structural) projection.
 *
 * To fix a failure: `cd packages/core && bun run generate:schemas`.
 */

import { describe, it, expect } from "bun:test";
import { toJSONSchema } from "zod/v4/core";
import { afpsJsonSchemaOverride } from "@afps-spec/schema";
import { integrationManifestSchema } from "../src/integration.ts";

const committed = JSON.parse(
  await Bun.file(`${import.meta.dir}/../schema/integration.schema.json`).text(),
) as Record<string, unknown>;

// Reproduce exactly what scripts/generate-schemas.ts writes for this entry.
const jsonSchema = toJSONSchema(integrationManifestSchema, {
  unrepresentable: "any",
  target: "draft-2020-12",
  override: afpsJsonSchemaOverride,
}) as Record<string, unknown>;
delete jsonSchema.$schema;

const generated = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Appstrate Integration Manifest",
  description:
    "Appstrate integration manifest — derived from the canonical Zod schema (packages/core/src/integration.ts). Cross-field rules (server || apiCall, per-auth delivery) are enforced by the Zod superRefines and are not representable in JSON Schema.",
  ...jsonSchema,
};

describe("integration.schema.json is generated from the Zod schema", () => {
  it("matches the current generate:schemas output (run `bun run generate:schemas` if this fails)", () => {
    expect(committed).toEqual(generated);
  });
});
