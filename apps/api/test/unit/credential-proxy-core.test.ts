// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for credential-proxy core — isolated from DB / HTTP.
 * Focus: response size capping (Phase A.1). The full proxyCall() is
 * exercised in integration tests via the /api/credential-proxy/proxy
 * route; these tests pin the pure streaming behaviour.
 */

import { describe, it, expect } from "bun:test";
import { _capResponseBodyForTesting as capResponseBody } from "../../src/services/credential-proxy/core.ts";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

describe("capResponseBody", () => {
  it("passes through responses smaller than the cap unchanged", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const source = streamFromChunks(chunks);
    const { body, ...rest } = capResponseBody(source, 100);
    const bytes = await drain(body);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(rest.truncated).toBe(false);
  });

  it("emits exactly `maxBytes` and flags truncated when the cap is exceeded", async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
    const source = streamFromChunks(chunks);
    const result = capResponseBody(source, 5);
    const bytes = await drain(result.body);
    expect(bytes.byteLength).toBe(5);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncated when upstream ends exactly at the cap", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const source = streamFromChunks(chunks);
    const result = capResponseBody(source, 5);
    const bytes = await drain(result.body);
    expect(bytes.byteLength).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("truncates mid-chunk when a single chunk crosses the boundary", async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])];
    const source = streamFromChunks(chunks);
    const result = capResponseBody(source, 3);
    const bytes = await drain(result.body);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.truncated).toBe(true);
  });

  it("cancels the upstream source when the cap is hit", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = capResponseBody(source, 2);
    await drain(result.body);
    expect(result.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("handles empty upstream without flagging truncated", async () => {
    const source = streamFromChunks([]);
    const result = capResponseBody(source, 100);
    const bytes = await drain(result.body);
    expect(bytes.byteLength).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("handles zero-length chunks before the cap", async () => {
    const chunks = [new Uint8Array([]), new Uint8Array([1, 2]), new Uint8Array([])];
    const source = streamFromChunks(chunks);
    const result = capResponseBody(source, 10);
    const bytes = await drain(result.body);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(result.truncated).toBe(false);
  });
});
