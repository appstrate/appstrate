// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `parseConnectionFlags` — the repeated
 * `appstrate run --connection <integration>=<connection id>` values folded into
 * the launch body's `connection_overrides`. Pure, no I/O: a malformed value
 * throws here, before the command reaches the keyring or the network.
 */

import { describe, it, expect } from "bun:test";
import { parseConnectionFlags } from "../src/commands/run/connection-flag.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseConnectionFlags", () => {
  it("returns undefined when the flag was not passed, so the body carries no map", () => {
    expect(parseConnectionFlags(undefined)).toBeUndefined();
    expect(parseConnectionFlags([])).toBeUndefined();
  });

  it("reads one set per integration", () => {
    expect(parseConnectionFlags([`@acme/gmail=${A}`, `@acme/clickup=${B}`])).toEqual({
      "@acme/gmail": [A],
      "@acme/clickup": [B],
    });
  });

  it("accumulates the values of one integration into its set, in the order given", () => {
    expect(
      parseConnectionFlags([`@acme/gmail=${B}`, `@acme/clickup=${A}`, `@acme/gmail=${A}`]),
    ).toEqual({
      "@acme/gmail": [B, A],
      "@acme/clickup": [A],
    });
  });

  it("trims the whitespace around either side", () => {
    expect(parseConnectionFlags([` @acme/gmail = ${A} `])).toEqual({ "@acme/gmail": [A] });
  });

  for (const malformed of ["@acme/gmail", `=${A}`, "@acme/gmail=", "=", "", " = "]) {
    it(`refuses ${JSON.stringify(malformed)} as a usage error naming the expected form`, () => {
      let err: unknown = null;
      try {
        parseConnectionFlags([`@acme/clickup=${A}`, malformed]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`Invalid --connection "${malformed}"`);
      expect((err as Error & { hint: string }).hint).toContain(
        "--connection <integration>=<connection id>",
      );
    });
  }
});
