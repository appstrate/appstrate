// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseVersionEtag, versionEtag } from "../src/etag.ts";

describe("versionEtag / parseVersionEtag", () => {
  it("round-trips a version through its strong tag", () => {
    for (const version of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(versionEtag(version)).toBe(`"${version}"`);
      expect(parseVersionEtag(versionEtag(version))).toBe(version);
    }
  });

  it("reads no version from anything else", () => {
    for (const etag of [
      null,
      undefined,
      "",
      "3",
      'W/"3"',
      '"3',
      '"-1"',
      '"1.5"',
      '"a"',
      "*",
      '"99999999999999999999"',
      '"007"',
      '"00"',
      '"+3"',
      '" 3"',
    ]) {
      expect(parseVersionEtag(etag)).toBeNull();
    }
  });
});
