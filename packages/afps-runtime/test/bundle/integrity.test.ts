// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  bundleIntegrity,
  computeRecordEntries,
  integrityEqual,
  parseRecord,
  recordFileHash,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";
import type { PackageIdentity } from "../../src/bundle/types.ts";
import { BundleError } from "../../src/bundle/errors.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("recordFileHash", () => {
  it("produces sha256=<b64-no-pad> form", () => {
    const data = enc("hello");
    const hash = recordFileHash(data);
    expect(hash).toMatch(/^sha256=[A-Za-z0-9+/]+$/);
    // No b64 padding after the `sha256=` prefix
    expect(hash.slice("sha256=".length)).not.toContain("=");
    // Compare against a hand-computed hash
    const expected = createHash("sha256").update(data).digest("base64").replace(/=+$/, "");
    expect(hash).toBe(`sha256=${expected}`);
  });

  it("differs for distinct inputs", () => {
    expect(recordFileHash(enc("a"))).not.toBe(recordFileHash(enc("b")));
  });
});

describe("serializeRecord / parseRecord round-trip", () => {
  it("emits sorted, comma-separated, LF-terminated lines", () => {
    const record = serializeRecord([
      { path: "b.txt", hash: "sha256=abc", size: 3 },
      { path: "a.txt", hash: "sha256=def", size: 4 },
    ]);
    expect(record).toBe("a.txt,sha256=def,4\nb.txt,sha256=abc,3\n");
  });

  it("rejects duplicate paths on emit", () => {
    expect(() =>
      serializeRecord([
        { path: "dup.txt", hash: "sha256=a", size: 1 },
        { path: "dup.txt", hash: "sha256=b", size: 1 },
      ]),
    ).toThrow(BundleError);
  });

  it("parses RECORD bodies back to entries", () => {
    const body = "a.txt,sha256=def,4\nb.txt,sha256=abc,3\n";
    const entries = parseRecord(body);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: "a.txt", hash: "sha256=def", size: 4 });
  });

  it("rejects CR characters in the body", () => {
    expect(() => parseRecord("a.txt,sha256=x,1\r\n")).toThrow(/CR/);
  });

  it("rejects malformed lines", () => {
    expect(() => parseRecord("no-commas-here\n")).toThrow(/malformed/);
    expect(() => parseRecord("a.txt,notsha,1\n")).toThrow(/malformed/);
    expect(() => parseRecord("a.txt,sha256=x,-1\n")).toThrow(/malformed/);
  });

  it("handles empty body", () => {
    expect(parseRecord("")).toEqual([]);
  });
});

describe("computeRecordEntries", () => {
  it("omits RECORD itself", () => {
    const files = new Map<string, Uint8Array>([
      ["manifest.json", enc("{}")],
      ["RECORD", enc("ignored")],
    ]);
    const entries = computeRecordEntries(files);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("manifest.json");
  });
});

describe("recordIntegrity", () => {
  it("returns SRI-form sha256-<b64-padded>", () => {
    const i = recordIntegrity("some record body\n");
    expect(i).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
    // SRI includes padding
    expect(i.endsWith("=") || i.length % 4 === 0).toBe(true);
  });
});

describe("bundleIntegrity", () => {
  it("is insensitive to insertion order of packages", () => {
    const a = new Map<PackageIdentity, { path: string; integrity: string }>([
      ["@me/a@1.0.0" as PackageIdentity, { path: "packages/@me/a/1.0.0/", integrity: "sha256-x" }],
      ["@me/b@1.0.0" as PackageIdentity, { path: "packages/@me/b/1.0.0/", integrity: "sha256-y" }],
    ]);
    const b = new Map<PackageIdentity, { path: string; integrity: string }>([
      ["@me/b@1.0.0" as PackageIdentity, { path: "packages/@me/b/1.0.0/", integrity: "sha256-y" }],
      ["@me/a@1.0.0" as PackageIdentity, { path: "packages/@me/a/1.0.0/", integrity: "sha256-x" }],
    ]);
    expect(bundleIntegrity(a)).toBe(bundleIntegrity(b));
  });

  it("changes when a per-package integrity changes", () => {
    const a = new Map<PackageIdentity, { path: string; integrity: string }>([
      ["@me/a@1.0.0" as PackageIdentity, { path: "packages/@me/a/1.0.0/", integrity: "sha256-x" }],
    ]);
    const b = new Map<PackageIdentity, { path: string; integrity: string }>([
      ["@me/a@1.0.0" as PackageIdentity, { path: "packages/@me/a/1.0.0/", integrity: "sha256-y" }],
    ]);
    expect(bundleIntegrity(a)).not.toBe(bundleIntegrity(b));
  });
});

describe("integrityEqual", () => {
  it("is true for identical strings", () => {
    expect(integrityEqual("sha256-abc", "sha256-abc")).toBe(true);
  });
  it("is false for differing lengths", () => {
    expect(integrityEqual("sha256-a", "sha256-abc")).toBe(false);
  });
  it("is false for differing content", () => {
    expect(integrityEqual("sha256-aaa", "sha256-bbb")).toBe(false);
  });
});
