// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `readResponse` — the defensive reader that turns a dispatched
 * platform `Response` into a tool result. These branches are HIGH-value
 * hardening (a streaming body that never resolves would hang the server
 * promise; an unbounded list dump would blow the model context) yet are not
 * otherwise exercised, so they get direct coverage here.
 *
 * Pure function, no DB, no app — each case constructs a `Response` and asserts
 * the shape of the parsed result. The SSE case uses a Response whose `.text()`
 * throws, proving the body is never buffered.
 */

import { describe, it, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readResponse } from "../../tools.ts";

function parse(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * A Response-like whose `.text()` rejects if called — lets us assert that the
 * SSE branch returns WITHOUT ever buffering the body. (A real open SSE stream
 * never resolves `.text()`, which would hang the request promise.)
 */
function unreadableSseResponse(status = 200): Response {
  const headers = new Headers({ "content-type": "text/event-stream" });
  return {
    status,
    headers,
    text: () => Promise.reject(new Error("body must not be read for SSE")),
  } as unknown as Response;
}

describe("readResponse — SSE refusal", () => {
  it("refuses a text/event-stream body without reading it", async () => {
    const result = await readResponse(unreadableSseResponse(200));
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.status).toBe(200);
    expect(String(body.error)).toContain("text/event-stream");
  });

  it("flags SSE refusal as an error even on a 2xx status", async () => {
    // The stream itself is "successful" HTTP-wise, but it is unusable here, so
    // the tool result must surface isError so the model doesn't treat the
    // refusal text as the operation's payload.
    const result = await readResponse(unreadableSseResponse(200));
    expect(result.isError).toBe(true);
  });
});

describe("readResponse — non-text bodies", () => {
  it("summarises a binary body instead of decoding it", async () => {
    const response = new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
    });
    const result = await readResponse(response);
    expect(result.isError).toBe(false);
    const body = parse(result);
    expect(body.status).toBe(200);
    expect(body.note).toBe("Non-text response body omitted.");
    expect(body.content_type).toBe("application/octet-stream");
    expect(body.bytes).toBe(4);
  });

  it("reports null bytes when content-length is absent", async () => {
    const response = new Response("ignored", {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    const result = await readResponse(response);
    const body = parse(result);
    expect(body.content_type).toBe("image/png");
    expect(body.bytes).toBeNull();
  });

  it("propagates an error status for a non-text body", async () => {
    const response = new Response(new Uint8Array([0]), {
      status: 502,
      headers: { "content-type": "application/zip", "content-length": "1" },
    });
    const result = await readResponse(response);
    expect(result.isError).toBe(true);
    expect(parse(result).status).toBe(502);
  });
});

describe("readResponse — text bodies", () => {
  it("parses a JSON body into an object", async () => {
    const response = new Response(JSON.stringify({ hello: "world", n: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const body = parse(await readResponse(response));
    expect(body.status).toBe(200);
    expect(body.body).toEqual({ hello: "world", n: 1 });
    expect(body.truncated).toBeUndefined();
  });

  it("falls back to the raw string when JSON is malformed", async () => {
    const response = new Response("{not valid json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await readResponse(response);
    expect(result.isError).toBe(false);
    const body = parse(result);
    expect(body.body).toBe("{not valid json");
  });

  it("keeps a plain-text body as a string", async () => {
    const response = new Response("just text", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    expect(parse(await readResponse(response)).body).toBe("just text");
  });

  it("treats an empty content-type as textual", async () => {
    const response = new Response("body-without-type", { status: 200 });
    // Note: the fetch/Response default content-type is text/plain;charset, but
    // an explicitly empty header must still be treated as textual.
    const explicit = new Response("x", { status: 200, headers: { "content-type": "" } });
    expect(parse(await readResponse(explicit)).body).toBe("x");
    expect(parse(await readResponse(response)).status).toBe(200);
  });

  it("truncates an oversized text body and flags it", async () => {
    // 100_001 chars of valid JSON-string content: over the 100K cap, so it is
    // sliced and `truncated: true`. A truncated body is intentionally NOT
    // re-parsed as JSON (it's no longer valid) — it stays a raw string.
    const huge = "x".repeat(100_001);
    const response = new Response(JSON.stringify(huge), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await readResponse(response);
    const body = parse(result);
    expect(body.truncated).toBe(true);
    expect((body.body as string).length).toBe(100_000);
  });

  it("does not flag a body exactly at the cap", async () => {
    const exact = "y".repeat(100_000);
    const response = new Response(exact, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const body = parse(await readResponse(response));
    expect(body.truncated).toBeUndefined();
    expect((body.body as string).length).toBe(100_000);
  });
});
