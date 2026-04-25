// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the run-scoped blob cache (Phase 3a of #276).
 *
 * Coverage focus:
 *   - URI shape conforms to the migration plan §V2.
 *   - URIs are unguessable (no sequential IDs).
 *   - Cross-run reads are silently rejected (security: §I3 isolation).
 *   - Path-traversal attempts are rejected.
 *   - Cumulative size limit is enforced.
 */

import { describe, it, expect } from "bun:test";
import { BlobStore, blobUri, generateUlid, parseBlobUri } from "../blob-store.ts";

describe("generateUlid", () => {
  it("returns a 26-char Crockford base32 string", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it("produces distinct ids for back-to-back calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i += 1) set.add(generateUlid());
    expect(set.size).toBe(1000);
  });
});

describe("parseBlobUri", () => {
  it("parses well-formed URIs", () => {
    const uri = blobUri("run-abc", "01HZX0Q3ABCDEFGHJKMNPQRSTV");
    expect(parseBlobUri(uri)).toEqual({
      runId: "run-abc",
      id: "01HZX0Q3ABCDEFGHJKMNPQRSTV",
    });
  });

  it("rejects wrong scheme", () => {
    expect(parseBlobUri("file:///run/abc/123")).toBeNull();
    expect(parseBlobUri("https://example.com/run/abc/123")).toBeNull();
  });

  it("rejects path traversal sequences", () => {
    expect(parseBlobUri("appstrate://provider-response/../etc/passwd/abc")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/run-1/../../foo")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response//run-1/abc")).toBeNull();
  });

  it("rejects percent-encoded traversal vectors", () => {
    expect(parseBlobUri("appstrate://provider-response/run-1%2Fabc")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/run%2E%2E/abc")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/run\\1/abc")).toBeNull();
  });

  it("rejects URIs with query string or fragment", () => {
    expect(parseBlobUri("appstrate://provider-response/run-1/abc?x=1")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/run-1/abc#frag")).toBeNull();
  });

  it("rejects URIs without exactly two path components", () => {
    expect(parseBlobUri("appstrate://provider-response/run-1")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/a/b/c")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/")).toBeNull();
  });

  it("rejects illegal characters in the run id", () => {
    expect(parseBlobUri("appstrate://provider-response/run with spaces/abc")).toBeNull();
    expect(parseBlobUri("appstrate://provider-response/run$/abc")).toBeNull();
  });
});

describe("BlobStore", () => {
  it("stores bytes and returns the URI in the expected shape", () => {
    const store = new BlobStore("run-1");
    const record = store.put(new TextEncoder().encode("hello"));
    expect(record.uri).toMatch(/^appstrate:\/\/provider-response\/run-1\/[A-Z0-9]{26}$/);
    expect(record.mimeType).toBe("application/octet-stream");
    expect(record.bytes).toEqual(new TextEncoder().encode("hello"));
  });

  it("retrieves stored blobs by URI", () => {
    const store = new BlobStore("run-1");
    const record = store.put(new TextEncoder().encode("hi"), { mimeType: "text/plain" });
    const out = store.read(record.uri);
    expect(out).not.toBeNull();
    expect(out!.bytes).toEqual(new TextEncoder().encode("hi"));
    expect(out!.mimeType).toBe("text/plain");
  });

  it("returns null for cross-run reads (security invariant)", () => {
    const a = new BlobStore("run-a");
    const b = new BlobStore("run-b");
    const record = a.put(new Uint8Array([1, 2, 3]));
    expect(b.read(record.uri)).toBeNull();
  });

  it("returns null for malformed URIs", () => {
    const store = new BlobStore("run-1");
    expect(store.read("file:///etc/passwd")).toBeNull();
    expect(store.read("appstrate://provider-response/run-1/../foo")).toBeNull();
  });

  it("returns null for unknown ids in this run", () => {
    const store = new BlobStore("run-1");
    expect(store.read("appstrate://provider-response/run-1/01HZX0Q3ABCDEFGHJKMNPQRSTV")).toBeNull();
  });

  it("enforces cumulative size cap", () => {
    const store = new BlobStore("run-1", { maxTotalBytes: 100 });
    store.put(new Uint8Array(60));
    expect(() => store.put(new Uint8Array(50))).toThrow(/cumulative size/);
  });

  it("tracks bytesUsed accurately", () => {
    const store = new BlobStore("run-1");
    expect(store.bytesUsed()).toBe(0);
    store.put(new Uint8Array(10));
    store.put(new Uint8Array(20));
    expect(store.bytesUsed()).toBe(30);
  });

  it("enumerates URIs via list()", () => {
    const store = new BlobStore("run-1");
    const r1 = store.put(new Uint8Array(1), { source: "provider:gmail", mimeType: "text/plain" });
    const r2 = store.put(new Uint8Array(2), { source: "provider:notion" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.uri).sort()).toEqual([r1.uri, r2.uri].sort());
    expect(list.find((r) => r.name === "provider:gmail")).toBeDefined();
    expect(list.find((r) => r.name === "provider:notion")).toBeDefined();
  });

  it("clear() drops everything", () => {
    const store = new BlobStore("run-1");
    store.put(new Uint8Array(1));
    store.put(new Uint8Array(2));
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.bytesUsed()).toBe(0);
  });
});
