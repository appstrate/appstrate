// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createUploader, isUploadUri } from "../src/schema-form/upload-client.ts";

describe("isUploadUri", () => {
  it("accepts valid upload:// strings", () => {
    expect(isUploadUri("upload://upl_abc")).toBe(true);
  });

  it("rejects other strings", () => {
    expect(isUploadUri("https://example.com/file")).toBe(false);
    expect(isUploadUri("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isUploadUri(null)).toBe(false);
    expect(isUploadUri(undefined)).toBe(false);
    expect(isUploadUri(123)).toBe(false);
    expect(isUploadUri({})).toBe(false);
  });
});

describe("createUploader", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset to a fresh mock for each test — individual tests install their own.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs descriptor, PUTs binary, returns uri", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const calls: { url: string; init?: RequestInit }[] = [];

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            id: "upl_abc",
            uri: "upload://upl_abc",
            url: "https://storage.example.com/upl_abc",
            method: "PUT",
            headers: { "Content-Type": "text/plain" },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const upload = createUploader("/api/uploads");
    const uri = await upload(file);

    expect(uri).toBe("upload://upl_abc");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("/api/uploads");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.name).toBe("hello.txt");
    expect(body.size).toBe(5);
    expect(body.mime).toMatch(/^text\/plain/);
    expect(calls[1]!.url).toBe("https://storage.example.com/upl_abc");
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(calls[1]!.init?.body).toBe(file);
  });

  it("falls back to application/octet-stream when file has no mime", async () => {
    const file = new File(["x"], "blob");
    let capturedBody: string | undefined;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (!capturedBody) capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "upl_x",
          uri: "upload://upl_x",
          url: "https://s/upl_x",
          method: "PUT",
          headers: {},
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await createUploader("/api/uploads")(file);
    expect(JSON.parse(capturedBody!).mime).toBe("application/octet-stream");
  });

  it("propagates RFC 9457 `detail` on init failure", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ detail: "quota exceeded" }), { status: 413 }),
    ) as unknown as typeof fetch;

    await expect(createUploader("/api/uploads")(new File(["x"], "x"))).rejects.toThrow(
      "quota exceeded",
    );
  });

  it("falls back to status text when init response is not JSON", async () => {
    globalThis.fetch = mock(
      async () => new Response("<html>oops</html>", { status: 500, statusText: "Server Error" }),
    ) as unknown as typeof fetch;

    await expect(createUploader("/api/uploads")(new File(["x"], "x"))).rejects.toThrow(
      "Server Error",
    );
  });

  it("throws on PUT failure", async () => {
    let n = 0;
    globalThis.fetch = mock(async () => {
      n++;
      if (n === 1) {
        return new Response(
          JSON.stringify({
            id: "upl_a",
            uri: "upload://upl_a",
            url: "https://s/upl_a",
            method: "PUT",
            headers: {},
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 502, statusText: "Bad Gateway" });
    }) as unknown as typeof fetch;

    await expect(createUploader("/api/uploads")(new File(["x"], "x"))).rejects.toThrow(
      /upload failed: 502/,
    );
  });

  it("forwards AbortSignal to both fetch calls", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (signals.length === 1) {
        return new Response(
          JSON.stringify({
            id: "upl_a",
            uri: "upload://upl_a",
            url: "https://s/upl_a",
            method: "PUT",
            headers: {},
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    await createUploader("/api/uploads")(new File(["x"], "x"), ctrl.signal);
    expect(signals[0]).toBe(ctrl.signal);
    expect(signals[1]).toBe(ctrl.signal);
  });
});
