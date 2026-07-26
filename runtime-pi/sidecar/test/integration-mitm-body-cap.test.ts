// SPDX-License-Identifier: Apache-2.0

/**
 * The MITM listener's inner-request body cap.
 *
 * The sidecar runs in a 256 MiB cgroup. `handleInnerRequest` used to call
 * `await req.arrayBuffer()` and compare the size AFTERWARDS, so an over-cap
 * body was fully resident before being refused — and the per-SNI `Bun.serve`
 * carried Bun's 128 MiB default body limit rather than the 10 MiB the listener
 * enforces. These tests pin the two guarantees that fix implies: refuse on the
 * declared length without touching the body, and refuse a lying/absent
 * `Content-Length` without buffering past the cap.
 *
 * No TLS here — `handleInnerRequest` is driven directly (function-parameter
 * injection: credentials, fetch, cap and event sink are all arguments).
 */

import { describe, it, expect } from "bun:test";
import {
  handleInnerRequest,
  type MitmCredentialSource,
  type MitmListenerEvent,
} from "../integration-mitm-listener.ts";

const CAP = 256 * 1024;
const CHUNK = 16 * 1024;

const noCredentials: MitmCredentialSource = {
  current: () => ({ auths: [] }),
  deliveryPlans: () => ({}),
};

/** Upstream must never be reached on a refusal path. */
const forbiddenFetch = (() => {
  throw new Error("upstream fetch must not be called for a refused request");
}) as unknown as typeof fetch;

/**
 * A body that keeps producing until it is cancelled, reporting how much it
 * actually handed over. `produced` is the memory the sidecar was asked to hold.
 */
function endlessBody(): { stream: ReadableStream<Uint8Array>; produced: () => number } {
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK));
    },
  });
  return { stream, produced: () => produced };
}

describe("MITM listener — inner-request body cap", () => {
  it("refuses on Content-Length before reading a single byte", async () => {
    const { stream, produced } = endlessBody();
    const events: MitmListenerEvent[] = [];
    const req = new Request("https://127.0.0.1/v1/things", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 * 1024) },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const res = await handleInnerRequest(
      req,
      "api.test.local",
      noCredentials,
      forbiddenFetch,
      CAP,
      (e) => events.push(e),
    );

    expect(res.status).toBe(413);
    // 64 MiB declared, at most the runtime's own one-chunk prefetch produced:
    // the handler refused without pulling the body at all.
    expect(produced()).toBeLessThanOrEqual(CHUNK);
    expect(events).toEqual([
      {
        kind: "request-refused",
        url: "https://api.test.local/v1/things",
        reason: "body too large",
      },
    ]);
  });

  it("refuses an undeclared over-cap body without buffering the whole of it", async () => {
    const { stream, produced } = endlessBody();
    const events: MitmListenerEvent[] = [];
    // No Content-Length: chunked upload, the size is only known as it arrives.
    const req = new Request("https://127.0.0.1/v1/things", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    const res = await handleInnerRequest(
      req,
      "api.test.local",
      noCredentials,
      forbiddenFetch,
      CAP,
      (e) => events.push(e),
    );

    expect(res.status).toBe(413);
    // The read is cancelled the moment the cap is crossed. The stream is
    // infinite, so a full buffer would never terminate — bounding what it
    // produced to just past the cap is the proof it stopped early.
    expect(produced()).toBeGreaterThan(0);
    expect(produced()).toBeLessThanOrEqual(CAP + 2 * CHUNK);
    expect(events).toEqual([
      {
        kind: "request-refused",
        url: "https://api.test.local/v1/things",
        reason: "body too large",
      },
    ]);
  });

  it("lets a body at the cap through to the planner", async () => {
    const events: MitmListenerEvent[] = [];
    const req = new Request("https://127.0.0.1/v1/things", {
      method: "POST",
      body: new Uint8Array(CAP),
    });

    const res = await handleInnerRequest(
      req,
      "api.test.local",
      noCredentials,
      forbiddenFetch,
      CAP,
      (e) => events.push(e),
    );

    // Whatever the planner decides for an unauthenticated host, the body itself
    // was accepted — the cap is inclusive.
    expect(res.status).not.toBe(413);
    expect(events.some((e) => e.kind === "request-refused" && e.reason === "body too large")).toBe(
      false,
    );
  });
});
