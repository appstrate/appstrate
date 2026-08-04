// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { healthPaths } from "../../src/openapi/paths/health.ts";

describe("health OpenAPI readiness contract", () => {
  it("documents every 503 state emitted by the health route and boot gate", () => {
    const okSchema = healthPaths["/health"].get.responses["200"].content["application/json"].schema;
    const schema = healthPaths["/health"].get.responses["503"].content["application/json"].schema;
    const variants = schema.oneOf;
    const statuses = variants.flatMap((variant) => variant.properties.status.enum);

    expect(okSchema.properties.status.enum).toEqual(["healthy", "degraded", "unhealthy"]);
    expect(statuses.sort()).toEqual(["draining", "starting", "unhealthy"]);
    expect(variants[0]?.required).toEqual(["status", "version"]);
    expect(variants[1]?.required).toEqual(["status", "version", "uptime_ms", "checks"]);
  });
});
