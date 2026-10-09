// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: the published `TokenUsage` component vs `parseTokenUsage`, the rule every ingestion
 * seam applies. A runner validating against the spec must send what the platform stores as sent.
 */

import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { MAX_TOKEN_USAGE_TIERS, parseTokenUsage } from "@appstrate/afps-shared/token-usage";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { createOpenApiValidator } from "../helpers/openapi-validator.ts";

interface SchemaNode {
  properties: Record<string, unknown>;
}

const spec = buildOpenApiSpec() as unknown as {
  components: { schemas: Record<string, SchemaNode> };
  paths: Record<
    string,
    { post: { requestBody: { content: Record<string, { schema: SchemaNode }> } } }
  >;
};
const validate = new Ajv({ strict: false }).compile(
  createOpenApiValidator(spec).dereference({
    $ref: "#/components/schemas/TokenUsage",
  }) as object,
);

/** True when the parser stores the raw usage exactly as sent. */
function keptVerbatim(raw: unknown): boolean {
  const { usage, tiersDropped } = parseTokenUsage(raw);
  return usage !== null && !tiersDropped && Bun.deepEquals(usage, raw);
}

const ACCEPTED: unknown[] = [
  {},
  { input_tokens: 0, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
  {
    input_tokens: 300_000,
    tiers: [
      { input_tokens_above: 200_000, input_tokens: 250_000 },
      { input_tokens_above: 272_000 },
    ],
  },
];

const REFUSED: unknown[] = [
  null,
  [],
  "usage",
  { input_tokens: 1.5 },
  { input_tokens: -1 },
  { input_tokens: "1" },
  { input_tokens: 1, cost: 0.2 },
  { tiers: [{ input_tokens_above: 0 }] },
  { tiers: [{ input_tokens_above: 1, output_tokens: 0.5 }] },
  { tiers: [{ input_tokens_above: 1, extra: true }] },
  {
    tiers: Array.from({ length: MAX_TOKEN_USAGE_TIERS + 1 }, (_, i) => ({
      input_tokens_above: i + 1,
    })),
  },
];

describe("TokenUsage component ↔ parseTokenUsage", () => {
  it("accepts exactly what the parser keeps verbatim", () => {
    for (const [fixture, expected] of [
      ...ACCEPTED.map((f) => [f, true] as const),
      ...REFUSED.map((f) => [f, false] as const),
    ]) {
      expect({ fixture, spec: validate(fixture), parser: keptVerbatim(fixture) }).toEqual({
        fixture,
        spec: expected,
        parser: expected,
      });
    }
  });

  it("leaves threshold uniqueness to the parser, which JSON Schema cannot state", () => {
    const fixture = { tiers: [{ input_tokens_above: 1 }, { input_tokens_above: 1 }] };
    expect({ spec: validate(fixture), parser: keptVerbatim(fixture) }).toEqual({
      spec: true,
      parser: false,
    });
  });

  it("is the one shape of a run's token_usage and of the finalize body's usage", () => {
    const ref = "#/components/schemas/TokenUsage";
    expect(spec.components.schemas.Run!.properties.token_usage).toMatchObject({
      oneOf: [{ $ref: ref }, { type: "null" }],
    });
    const finalize = spec.paths["/api/runs/{runId}/events/finalize"]!.post.requestBody;
    expect(finalize.content["application/json"]!.schema.properties.usage).toMatchObject({
      $ref: ref,
    });
  });
});
