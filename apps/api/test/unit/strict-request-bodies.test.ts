// SPDX-License-Identifier: Apache-2.0

/**
 * Every documented request body is CLOSED.
 *
 * `routes/runs.ts` states the rule as universal — "the launch body was the last
 * place the rule did not hold" — but only six route files applied `.strict()`;
 * ~45 `z.object()` bodies stripped unknown fields in silence. The concrete cost:
 * `PUT /api/spaces/{spaceId}/packages/{scope}/{name}` with `generation_config`
 * (the snake spelling a client would reasonably guess, since `schedules.ts`
 * spells the same concept `generation_config_override`) answered 200 and
 * changed nothing.
 *
 * This is the standing guard, not a sample of it: `zod-schema-registry.ts`
 * already names every documented body's Zod schema for `verify-openapi`, so
 * sweeping it covers each route family at once and a NEW loose body fails here
 * the day it is added.
 */

import { describe, it, expect } from "bun:test";
import { buildZodSchemaRegistry } from "../../src/openapi/zod-schema-registry.ts";

/**
 * Whether a JSON Schema closes its object shape. A discriminated union emits
 * `anyOf`/`oneOf` with no top-level `additionalProperties`, so it is closed
 * only when EVERY branch is.
 */
function isClosed(schema: Record<string, unknown>): boolean {
  const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(branches) && branches.length > 0) return branches.every(isClosed);
  return schema.additionalProperties === false;
}

describe("route request bodies", () => {
  it("reject unknown fields rather than stripping them", () => {
    const entries = buildZodSchemaRegistry();

    // Positive control: an empty (or near-empty) registry would make the
    // assertion below pass without checking anything.
    expect(entries.length).toBeGreaterThan(30);

    const open = entries
      .filter((e) => !isClosed(e.jsonSchema as Record<string, unknown>))
      .map((e) => `${e.method} ${e.path}`);

    expect(open).toEqual([]);
  });

  // Control for `isClosed` itself: a non-strict object must be reported OPEN,
  // or the sweep above would pass for a registry full of loose bodies.
  it("the closedness predicate can say no", () => {
    expect(isClosed({ type: "object", properties: {} })).toBe(false);
    expect(isClosed({ type: "object", additionalProperties: false })).toBe(true);
    expect(isClosed({ anyOf: [{ additionalProperties: false }, { type: "object" }] })).toBe(false);
  });
});
