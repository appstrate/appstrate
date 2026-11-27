// SPDX-License-Identifier: Apache-2.0

/** The core schema of `get_me` stays the shape `GET /api/me/context` documents. */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { meContextSchema } from "@appstrate/core/me-context";
import { buildOpenApiSpec } from "../../../../src/openapi/index.ts";

type Schema = {
  type?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};

const spec = (
  buildOpenApiSpec().paths["/api/me/context"] as never as {
    get: { responses: { "200": { content: { "application/json": { schema: Schema } } } } };
  }
).get.responses["200"].content["application/json"].schema;
const core = z.toJSONSchema(meContextSchema, { io: "input" }) as Schema;

/** Every object level, by path: its property names and which are required. */
function levels(schema: Schema, path = "$", out = new Map<string, string>()) {
  const target = schema.items ?? schema;
  if (target.properties) {
    out.set(
      path,
      Object.keys(target.properties)
        .sort()
        .map((key) => (target.required?.includes(key) ? `${key}!` : key))
        .join(","),
    );
    for (const [key, child] of Object.entries(target.properties)) {
      levels(child, `${path}.${key}`, out);
    }
  }
  return out;
}

describe("get_me body schema", () => {
  it("has the property names and required keys of the OpenAPI 200 schema at every level", () => {
    const specLevels = levels(spec);
    const coreLevels = levels(core);
    // Space-level keys are required together by `dependentRequired` in the spec, which JSON
    // Schema from Zod cannot state: they are checked as optional there.
    const space = ["connections", "connectable_integrations", "recent_runs", "agents", "skills"];
    const unrequired = (line: string) =>
      line
        .split(",")
        .map((key) => key.replace("!", ""))
        .sort()
        .join(",");
    expect([...coreLevels.keys()].sort()).toEqual([...specLevels.keys()].sort());
    for (const [path, line] of specLevels) {
      const got = coreLevels.get(path)!;
      if (path === "$") expect(unrequired(got)).toBe(unrequired(line));
      else expect(got).toBe(line);
    }
    expect(space.every((key) => key in spec.properties!)).toBe(true);
    expect(core.required).toEqual(spec.required!);
  });

  it("has the same enums as the OpenAPI schema", () => {
    expect(core.properties!.org!.properties!.role!.enum).toEqual(
      spec.properties!.org!.properties!.role!.enum,
    );
  });
});
