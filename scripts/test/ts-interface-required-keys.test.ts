// SPDX-License-Identifier: Apache-2.0

/**
 * `getTypeShape` feeds verify-openapi step 7, which compares a shared-type's
 * required-ness against its OpenAPI response schema in BOTH directions. The
 * reverse half (spec-required, type-optional) reads `optional`, and it can only
 * be read correctly if `required` and `optional` are two independently
 * populated sets rather than complements of one another: a name in NEITHER is
 * a name the type does not declare, which neither direction may report.
 *
 * These tests pin that invariant against real exported types, so a refactor of
 * the compiler-API walk cannot quietly turn the reverse check into a no-op —
 * an empty `optional` set would make it silently pass everything.
 */

import { describe, it, expect } from "bun:test";
import { getTypeShape } from "../lib/ts-interface-required-keys.ts";

describe("getTypeShape — required / optional partition", () => {
  it("reports a `?` member in `optional` and not in `required`", () => {
    // `AgentDetail.display_name` / `.description` are manifest-derived and
    // genuinely may be absent — a deliberate, stable optionality, so this pins
    // the partition without coupling to any field slated to change.
    const shape = getTypeShape("AgentDetail");
    expect(shape.optional.has("display_name")).toBe(true);
    expect(shape.required.has("display_name")).toBe(false);
    // Non-optional neighbours land on the other side.
    expect(shape.required.has("id")).toBe(true);
    expect(shape.optional.has("id")).toBe(false);
  });

  it("leaves `optional` empty for a type with no `?` members", () => {
    // The shape this PR flattened: every member is guaranteed by the endpoint,
    // so a `?` reappearing here is the drift step 7's reverse half now catches.
    const shape = getTypeShape("ResolvedRunConfig");
    expect([...shape.optional]).toEqual([]);
    expect([...shape.required].sort()).toEqual([
      "generation",
      "input",
      "modelId",
      "proxyId",
      "version_pin",
    ]);
  });

  it("partitions nested shapes too — the comparison recurses", () => {
    const nested = getTypeShape("ResolvedRunConfig").nested.get("input");
    expect(nested).toBeDefined();
    expect([...nested!.required].sort()).toEqual(["locked_fields", "values"]);
    expect([...nested!.optional]).toEqual([]);
  });

  it("does not read `| null` as optional — only `| undefined` is absence", () => {
    // The partition is read from `?` OR a member type that admits `undefined`,
    // because those are the same fact to a consumer and the reverse check must
    // not depend on which spelling the author picked. `| null` is a THIRD fact
    // and stays on the required side: it guarantees the KEY and only says the
    // value may be empty. Blurring the two would exempt every nullable field in
    // the tree from the reverse check — `ResolvedRunConfig` is nullable
    // throughout, so it would empty out entirely.
    const shape = getTypeShape("ResolvedRunConfig");
    expect(shape.required.has("generation")).toBe(true); // ModelGenerationSettings | null
    expect(shape.optional.has("generation")).toBe(false);
  });

  it("a name the type does not declare is in neither set", () => {
    const shape = getTypeShape("ResolvedRunConfig");
    expect(shape.required.has("no_such_field")).toBe(false);
    expect(shape.optional.has("no_such_field")).toBe(false);
  });
});
