// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isBlockedHost, isLoopbackHost } from "../src/ssrf.ts";

describe("isLoopbackHost", () => {
  it("recognises this machine in every form the URL parser normalises", () => {
    const loopback = [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "foo.localhost",
      "127.1",
      "0x7f.1",
      "2130706433",
      "0177.0.0.1",
      "0",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::127.0.0.1]",
    ];
    expect(loopback.filter((h) => !isLoopbackHost(h))).toEqual([]);
  });

  it("leaves internal and public hosts alone, though the first stay blocked", () => {
    const elsewhere = ["10.0.0.5", "169.254.169.254", "example.com"];
    expect(elsewhere.map(isLoopbackHost)).toEqual([false, false, false]);
    expect(elsewhere.map(isBlockedHost)).toEqual([true, true, false]);
  });

  it("counts an unparseable host as loopback (fail closed)", () => {
    for (const h of ["", "bad host", "%zz"]) {
      expect(isLoopbackHost(h)).toBe(true);
      expect(isBlockedHost(h)).toBe(true);
    }
  });
});
