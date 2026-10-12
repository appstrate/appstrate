// SPDX-License-Identifier: Apache-2.0

// `parseConnectionFlags`: the repeated `appstrate run --connection` values as the launch
// body's `connection_overrides`. Pure: a malformed value throws before any I/O.

import { describe, it, expect } from "bun:test";
import { parseConnectionFlags } from "../src/commands/run/connection-flag.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseConnectionFlags", () => {
  it("returns undefined when the flag was not passed, so the body carries no map", () => {
    expect(parseConnectionFlags([])).toBeUndefined();
  });

  it("accumulates the values of one integration into its set, in the order given", () => {
    expect(
      parseConnectionFlags([`@acme/gmail=${B}`, `@acme/clickup=${A}`, `@acme/gmail=${A}`]),
    ).toEqual({
      "@acme/gmail": [B, A],
      "@acme/clickup": [A],
    });
  });

  for (const malformed of ["@acme/gmail", `=${A}`, "@acme/gmail="]) {
    it(`refuses ${JSON.stringify(malformed)}, naming the expected form`, () => {
      expect(() => parseConnectionFlags([`@acme/clickup=${A}`, malformed])).toThrow(
        `Invalid --connection "${malformed}" (expected <integration>=<connection-id>)`,
      );
    });
  }
});
