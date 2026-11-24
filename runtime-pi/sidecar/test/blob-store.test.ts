// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the run-scoped blob cache.
 *
 * Coverage focus:
 *   - URI shape conforms to the documented `appstrate://blob/{run}/{ulid}` form.
 *   - URIs are unguessable (no sequential IDs).
 *   - Cross-run reads are silently rejected (run-scoped isolation).
 *   - Path-traversal attempts are rejected.
 *   - Cumulative size limit is enforced via LRU eviction on insert;
 *     only a single blob larger than the whole cap throws.
 */

import { describe, it, expect } from "bun:test";
import { BlobStore, blobUri, generateUlid, parseBlobUri } from "../blob-store.ts";

// `maxTotalBytes` is required on the store; cases that are not exercising the
// cap pass one large enough that no eviction can be triggered incidentally.
const NO_EVICTION = { maxTotalBytes: 256 * 1024 * 1024 };

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
    expect(parseBlobUri("appstrate://tool-output/../etc/passwd/abc")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/run-1/../../foo")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output//run-1/abc")).toBeNull();
  });

  it("rejects percent-encoded traversal vectors", () => {
    expect(parseBlobUri("appstrate://tool-output/run-1%2Fabc")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/run%2E%2E/abc")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/run\\1/abc")).toBeNull();
  });

  it("rejects URIs with query string or fragment", () => {
    expect(parseBlobUri("appstrate://tool-output/run-1/abc?x=1")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/run-1/abc#frag")).toBeNull();
  });

  it("rejects URIs without exactly two path components", () => {
    expect(parseBlobUri("appstrate://tool-output/run-1")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/a/b/c")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/")).toBeNull();
  });

  it("rejects illegal characters in the run id", () => {
    expect(parseBlobUri("appstrate://tool-output/run with spaces/abc")).toBeNull();
    expect(parseBlobUri("appstrate://tool-output/run$/abc")).toBeNull();
  });
});

describe("BlobStore", () => {
  it("stores bytes and returns the URI in the expected shape", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    const record = store.put(new TextEncoder().encode("hello"));
    expect(record.uri).toMatch(/^appstrate:\/\/tool-output\/run-1\/[A-Z0-9]{26}$/);
    expect(record.mimeType).toBe("application/octet-stream");
    expect(record.bytes).toEqual(new TextEncoder().encode("hello"));
  });

  it("retrieves stored blobs by URI", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    const record = store.put(new TextEncoder().encode("hi"), { mimeType: "text/plain" });
    const out = store.read(record.uri);
    expect(out).not.toBeNull();
    expect(out!.bytes).toEqual(new TextEncoder().encode("hi"));
    expect(out!.mimeType).toBe("text/plain");
  });

  it("returns null for cross-run reads (security invariant)", () => {
    const a = new BlobStore("run-a", NO_EVICTION);
    const b = new BlobStore("run-b", NO_EVICTION);
    const record = a.put(new Uint8Array([1, 2, 3]));
    expect(b.read(record.uri)).toBeNull();
  });

  it("returns null for malformed URIs", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    expect(store.read("file:///etc/passwd")).toBeNull();
    expect(store.read("appstrate://tool-output/run-1/../foo")).toBeNull();
  });

  it("returns null for unknown ids in this run", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    expect(store.read("appstrate://tool-output/run-1/01HZX0Q3ABCDEFGHJKMNPQRSTV")).toBeNull();
  });

  it("throws when a single blob alone exceeds the cap", () => {
    const store = new BlobStore("run-1", { maxTotalBytes: 100 });
    expect(() => store.put(new Uint8Array(101))).toThrow(/cumulative size/);
    expect(store.size()).toBe(0);
  });

  it("evicts the least-recently-used blob when inserting over the cap", () => {
    const store = new BlobStore("run-1", { maxTotalBytes: 100 });
    const oldest = store.put(new Uint8Array(60));
    const kept = store.put(new Uint8Array(30));
    const incoming = store.put(new Uint8Array(50)); // forces eviction of `oldest`
    expect(store.read(oldest.uri)).toBeNull();
    expect(store.read(kept.uri)).not.toBeNull();
    expect(store.read(incoming.uri)).not.toBeNull();
    expect(store.bytesUsed()).toBe(80);
  });

  it("read() refreshes recency — the eviction victim is the LRU blob, not the oldest insert", () => {
    const store = new BlobStore("run-1", { maxTotalBytes: 100 });
    const first = store.put(new Uint8Array(45));
    const second = store.put(new Uint8Array(45));
    // Touch `first` so `second` becomes the LRU entry.
    expect(store.read(first.uri)).not.toBeNull();
    store.put(new Uint8Array(45)); // evicts `second`
    expect(store.read(second.uri)).toBeNull();
    expect(store.read(first.uri)).not.toBeNull();
  });

  it("evicts multiple LRU blobs until the incoming blob fits", () => {
    const store = new BlobStore("run-1", { maxTotalBytes: 100 });
    const a = store.put(new Uint8Array(40));
    const b = store.put(new Uint8Array(40));
    const c = store.put(new Uint8Array(90)); // evicts both a and b
    expect(store.read(a.uri)).toBeNull();
    expect(store.read(b.uri)).toBeNull();
    expect(store.read(c.uri)).not.toBeNull();
    expect(store.bytesUsed()).toBe(90);
    expect(store.size()).toBe(1);
  });

  it("tracks bytesUsed accurately", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    expect(store.bytesUsed()).toBe(0);
    store.put(new Uint8Array(10));
    store.put(new Uint8Array(20));
    expect(store.bytesUsed()).toBe(30);
  });

  it("enumerates URIs via list()", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    const r1 = store.put(new Uint8Array(1), { source: "provider:gmail", mimeType: "text/plain" });
    const r2 = store.put(new Uint8Array(2), { source: "provider:notion" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.uri).sort()).toEqual([r1.uri, r2.uri].sort());
    expect(list.find((r) => r.name === "provider:gmail")).toBeDefined();
    expect(list.find((r) => r.name === "provider:notion")).toBeDefined();
  });

  it("clear() drops everything", () => {
    const store = new BlobStore("run-1", NO_EVICTION);
    store.put(new Uint8Array(1));
    store.put(new Uint8Array(2));
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.bytesUsed()).toBe(0);
  });
});

it("reads identical URIs only through their issuing client, subject to revocation, size and abort", async () => {
  const store = new BlobStore("run-a", { maxTotalBytes: 32 });
  const same = "records://shared/key";
  let permitted = true;
  let observed: AbortSignal | undefined;
  const first = store.link(same, {
    readResource: async ({ uri }, options) => {
      observed = options?.signal;
      if (!permitted) throw new Error("revoked");
      return { contents: [{ uri, text: "é" }] };
    },
  })!;
  const second = store.link(same, {
    readResource: async ({ uri }) => ({ contents: [{ uri, text: "b" }] }),
  })!;
  const controller = new AbortController();
  expect(first).not.toBe(second);
  expect(await store.readLink(first, controller.signal, 2)).toEqual({
    contents: [{ uri: first, text: "é" }],
  });
  expect(observed).toBe(controller.signal);
  expect(await store.readLink(second, undefined, 1)).toEqual({
    contents: [{ uri: second, text: "b" }],
  });
  expect(await store.readLink(first.replace("run-a", "run-b"), undefined, 2)).toBeNull();
  await expect(store.readLink(first, undefined, 1)).rejects.toThrow("size limit");
  permitted = false;
  await expect(store.readLink(first, undefined, 2)).rejects.toThrow("revoked");
  controller.abort();
  await expect(store.readLink(first, controller.signal, 2)).rejects.toThrow();
  store.clear();
  expect(await store.readLink(first, undefined, 2)).toBeNull();
});

it("gives each linked resource its own opaque handle, preserving order, repeat identity and aggregate limits", async () => {
  const store = new BlobStore("run-x", { maxTotalBytes: 10 });
  const collection = "records://upstream/notes";
  const child = "records://upstream/attachment";
  const contents = [
    { uri: collection, text: "é" },
    { uri: child, blob: "AP8=" },
    { uri: child, text: "x" },
  ];
  const readUris: string[] = [];
  const link = store.link(collection, {
    readResource: async ({ uri }) => {
      readUris.push(uri);
      return { contents: uri === collection ? contents : [{ uri, blob: "AP8=" }] };
    },
  })!;
  await expect(store.readLink(link, undefined, 4)).rejects.toThrow("size limit");
  const read = await store.readLink(link, undefined, 5);
  const childHandle = read!.contents[1]!.uri;
  expect(childHandle).toStartWith("appstrate://tool-output/run-x/");
  expect(childHandle).not.toBe(link);
  expect(read!.contents.map((item) => item.uri)).toEqual([link, childHandle, childHandle]);
  const again = await store.readLink(link, undefined, 5);
  expect(again!.contents.map((item) => item.uri)).toEqual([link, childHandle, childHandle]);
  expect(await store.readLink(childHandle, undefined, 2)).toEqual({
    contents: [{ uri: childHandle, blob: "AP8=" }],
  });
  expect(readUris).toEqual([collection, collection, collection, child]);
});

it("keeps the parent and all 1024 child handles stable when a read replaces a full link table", async () => {
  const store = new BlobStore("run-full", NO_EVICTION);
  const collection = "records://root";
  const members = Array.from({ length: 1024 }, (_, i) => ({
    uri: "records://member/" + i,
    text: "",
  }));
  const issuer = {
    readResource: async ({ uri }: { uri: string }) => ({
      contents: uri === collection ? members : [{ uri, text: uri }],
    }),
  };
  // Rotate out a previous batch, then put the parent and one existing child at the LRU end.
  for (let i = 0; i < 1025; i++) store.link("records://old/" + i, issuer);
  const parent = store.link(collection, issuer)!;
  const retainedChild = store.link(members[1023]!.uri, issuer)!;
  for (let i = 0; i < 1023; i++) store.link("records://filler/" + i, issuer);

  const result = await store.readLink(parent, undefined, 0);
  const handles = result!.contents.map((item) => item.uri);
  expect(new Set(handles).size).toBe(1024);
  expect(handles[1023]).toBe(retainedChild);
  const readAgain = await store.readLink(parent, undefined, 0);
  expect(readAgain!.contents.map((item) => item.uri)).toEqual(handles);
  for (const [i, handle] of handles.entries()) {
    const read = await store.readLink(handle, undefined, 128);
    expect(read?.contents).toEqual([{ uri: handle, text: members[i]!.uri }]);
  }
});

it("rejects a late oversized member URI without rotating any live handle", async () => {
  const store = new BlobStore("run-atomic", NO_EVICTION);
  const collection = "records://root";
  const issuer = {
    readResource: async ({ uri }: { uri: string }) => ({
      contents:
        uri === collection
          ? [
              { uri: "records://new", text: "" },
              { uri: "x".repeat(8193), text: "" },
            ]
          : [{ uri, text: "" }],
    }),
  };
  const oldest = store.link("records://oldest", issuer)!;
  const parent = store.link(collection, issuer)!;
  for (let i = 0; i < 1023; i++) store.link("records://other/" + i, issuer);
  await expect(store.readLink(parent, undefined, 0)).rejects.toThrow("URI size limit");
  expect(await store.readLink(oldest, undefined, 0)).toEqual({
    contents: [{ uri: oldest, text: "" }],
  });
  await expect(store.readLink(parent, undefined, 0)).rejects.toThrow("URI size limit");
});

it("queues upstream reads across connections and releases the turn after failure or cancellation", async () => {
  const store = new BlobStore("run-busy", NO_EVICTION);
  const pending = Promise.withResolvers<never>();
  const first = store.link("records://first", { readResource: () => pending.promise })!;
  let calls = 0;
  const next = store.link("records://next", {
    readResource: async ({ uri }) => {
      calls++;
      return { contents: [{ uri, text: "ok" }] };
    },
  })!;
  const reading = store.readLink(first, undefined, 10);
  const queued = store.readLink(next, undefined, 10);
  const leaving = new AbortController();
  const abandoned = store.readLink(next, leaving.signal, 10);
  leaving.abort(new Error("left the queue"));
  await expect(abandoned).rejects.toThrow("left the queue");
  await Bun.sleep(0);
  expect(calls).toBe(0);
  pending.reject(new Error("read failed"));
  await expect(reading).rejects.toThrow("read failed");
  expect(await queued).toEqual({ contents: [{ uri: next, text: "ok" }] });
  expect(calls).toBe(1);

  const abort = new AbortController();
  const cancellable = store.link("records://cancel", {
    readResource: async (_, options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true,
        });
      }),
  })!;
  const cancelled = store.readLink(cancellable, abort.signal, 10);
  abort.abort(new Error("read cancelled"));
  await expect(cancelled).rejects.toThrow("read cancelled");

  expect(await store.readLink(next, undefined, 10)).toEqual({
    contents: [{ uri: next, text: "ok" }],
  });
  expect(calls).toBe(2);
});

it("sends no upstream request for a link retired while its read was queued", async () => {
  const store = new BlobStore("run-retired", NO_EVICTION);
  const pending = Promise.withResolvers<{ contents: { uri: string; text: string }[] }>();
  const first = store.link("records://first", { readResource: () => pending.promise })!;
  let calls = 0;
  const queued = store.link("records://queued", {
    readResource: async ({ uri }) => {
      calls++;
      return { contents: [{ uri, text: "late" }] };
    },
  })!;
  const reading = store.readLink(first, undefined, 10);
  const waiting = store.readLink(queued, undefined, 10);
  store.clear();
  pending.resolve({ contents: [{ uri: "records://first", text: "ok" }] });
  expect(await reading).toBeNull();
  expect(await waiting).toBeNull();
  expect(calls).toBe(0);
});
