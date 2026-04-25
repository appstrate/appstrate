// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { findAppstrateOnPath, splitPath, type PathScanFs } from "../src/lib/path-scan.ts";

describe("splitPath", () => {
  it("returns directories in order", () => {
    expect(splitPath("/a:/b:/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("dedupes repeated entries (first wins)", () => {
    expect(splitPath("/a:/b:/a")).toEqual(["/a", "/b"]);
  });

  it("drops empty (current-dir) entries", () => {
    // Leading, trailing, and consecutive separators all canonicalise to "."
    // in POSIX shells. We refuse — auditing every binary in `pwd` is a footgun.
    expect(splitPath(":/a::/b:")).toEqual(["/a", "/b"]);
  });

  it("returns empty list on empty input", () => {
    expect(splitPath("")).toEqual([]);
  });

  it("supports a custom separator (Windows)", () => {
    expect(splitPath("C:\\a;C:\\b", ";")).toEqual(["C:\\a", "C:\\b"]);
  });
});

describe("findAppstrateOnPath", () => {
  function fakeFs(map: Record<string, { exec: boolean; real?: string }>): PathScanFs {
    return {
      async isExecutable(path) {
        return map[path]?.exec ?? false;
      },
      async realpath(path) {
        return map[path]?.real ?? path;
      },
    };
  }

  it("returns hits in PATH order", async () => {
    const fs = fakeFs({
      "/a/appstrate": { exec: true },
      "/b/appstrate": { exec: true },
      "/c/appstrate": { exec: false },
    });
    const hits = await findAppstrateOnPath("/a:/b:/c", "appstrate", fs);
    expect(hits.map((h) => h.pathEntry)).toEqual(["/a", "/b"]);
  });

  it("dedupes by realpath (symlink → same inode)", async () => {
    const fs = fakeFs({
      "/usr/local/bin/appstrate": { exec: true, real: "/opt/appstrate/bin/appstrate" },
      "/opt/appstrate/bin/appstrate": { exec: true, real: "/opt/appstrate/bin/appstrate" },
    });
    const hits = await findAppstrateOnPath("/usr/local/bin:/opt/appstrate/bin", "appstrate", fs);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pathEntry).toBe("/usr/local/bin");
  });

  it("returns empty when no entry has the binary", async () => {
    const fs = fakeFs({});
    const hits = await findAppstrateOnPath("/a:/b", "appstrate", fs);
    expect(hits).toEqual([]);
  });
});
