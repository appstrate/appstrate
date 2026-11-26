// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { flushBeforeFinalize, flushSidecarCallJournal } from "../mcp/call-journal-flush.ts";

const quiet = () => {};

describe("flushSidecarCallJournal", () => {
  it("POSTs /calls/flush with the sidecar token", async () => {
    const seen: { url: string; method?: string; token: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        method: init.method,
        token: new Headers(init.headers).get(SIDECAR_AUTH_HEADER),
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await flushSidecarCallJournal("http://sidecar:8080/", "agent-tok", fetchFn, quiet);
    expect(seen).toEqual([
      { url: "http://sidecar:8080/calls/flush", method: "POST", token: "agent-tok" },
    ]);
  });

  it("logs and resolves on a refused or failed flush", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await flushSidecarCallJournal(
      "http://sidecar",
      "t",
      (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
      log,
    );
    await flushSidecarCallJournal(
      "http://sidecar",
      "t",
      (async () => {
        throw new TypeError("Unable to connect");
      }) as unknown as typeof fetch,
      log,
    );
    expect(lines).toEqual([
      "[call-journal] flush answered HTTP 401\n",
      "[call-journal] flush failed: Unable to connect\n",
    ]);
  });
});

describe("flushBeforeFinalize", () => {
  it("finalizes only once the flush has resolved, and passes events through", async () => {
    const order: string[] = [];
    const inner: EventSink = {
      handle: async (event) => void order.push(`handle:${event.type}`),
      finalize: async (result) => void order.push(`finalize:${result.status}`),
    };
    const sink = flushBeforeFinalize(inner, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("flush");
    });
    await sink.handle({ type: "log.written", timestamp: 0, runId: "run_1" });
    await sink.finalize({ ...emptyRunResult(), status: "success" });
    expect(order).toEqual(["handle:log.written", "flush", "finalize:success"]);
  });
});
