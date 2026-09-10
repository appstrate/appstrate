// SPDX-License-Identifier: Apache-2.0

/**
 * §2 of `bun run verify:openapi`, the step that reported OK on every document ever handed to it
 * (#1360). The gate builds its document from the real source tree, so the only way to hand this
 * step a deliberately malformed one is through the helper it now delegates to.
 */

import { describe, it, expect } from "bun:test";
import { validate } from "@readme/openapi-parser";
import { validateOpenApiStructure } from "../lib/openapi-structure.ts";

/** Smallest document `@readme/openapi-parser` accepts: 3.1 needs a non-empty `paths`. */
const CONFORMING = {
  openapi: "3.1.0",
  info: { title: "Fixture", version: "1.0.0" },
  paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
};

/** A structural defect the parser reports and Redocly's ruleset (§3) does not. */
function withMissingInfoVersion(): unknown {
  const spec = structuredClone(CONFORMING) as { info: { version?: string } };
  delete spec.info.version;
  return spec;
}

describe("validateOpenApiStructure", () => {
  it("accepts a conforming document", async () => {
    expect(await validateOpenApiStructure(CONFORMING)).toBeNull();
  });

  it("fails a document missing a required field, naming the field", async () => {
    const failure = await validateOpenApiStructure(withMissingInfoVersion());
    expect(failure).not.toBeNull();
    expect(failure).toContain("version is missing here");
  });

  it("fails a document whose array schema declares no `items`", async () => {
    const spec = structuredClone(CONFORMING);
    spec.paths["/x"].get.responses["200"] = {
      description: "ok",
      content: { "application/json": { schema: { type: "array" } } },
    } as (typeof spec.paths)["/x"]["get"]["responses"]["200"];
    expect(await validateOpenApiStructure(spec)).toContain("`items` schema");
  });

  it("fails a document with an unresolvable internal $ref", async () => {
    const spec = structuredClone(CONFORMING);
    spec.paths["/x"].get.responses["200"] = {
      description: "ok",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Absent" } } },
    } as (typeof spec.paths)["/x"]["get"]["responses"]["200"];
    expect(await validateOpenApiStructure(spec)).toContain("Missing $ref pointer");
  });

  it("reports a document it cannot even read as a failure rather than throwing", async () => {
    const circular: Record<string, unknown> = { ...CONFORMING };
    circular.self = circular;
    const failure = await validateOpenApiStructure(circular);
    expect(failure).not.toBeNull();
    expect(failure!.toLowerCase()).toMatch(/cyclic|circular/);
  });

  it("does not lean on a throw: the parser RESOLVES on a malformed document", async () => {
    // The bug this file exists for. `await validate(bad)` inside a bare try/catch printed
    // `OK — valid OpenAPI 3.1 document.` and exited 0, because nothing was ever thrown.
    // Pin the library semantics so a refactor back to catch-only is a red test, not a silent gate.
    const result = await validate(withMissingInfoVersion() as Parameters<typeof validate>[0], {
      resolve: { external: false },
    });
    expect(result.valid).toBe(false);
  });
});
