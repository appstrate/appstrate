// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { RuntimeEventJournal, journalRuntimeToolDefs } from "../runtime-event-journal.ts";
import {
  buildRuntimeToolDefs,
  RUNTIME_TOOL_EVENTS_META_KEY,
} from "@appstrate/core/runtime-tool-defs";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    fetchCredentials: async () => ({
      credentials: { access_token: "x" },
      authorizedUris: [],
      allowAllUris: false,
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    }),
    cookieJar: new Map(),
    isReady: () => true,
    ...overrides,
  };
}

describe("RuntimeEventJournal", () => {
  it("assigns monotonic sequences and returns events after a cursor", () => {
    const j = new RuntimeEventJournal();
    j.append({ type: "log.written", message: "a" });
    j.append({ type: "log.written", message: "b" });
    j.append({ type: "log.written", message: "c" });

    const all = j.after(0);
    expect(all.events.map((e) => e.message)).toEqual(["a", "b", "c"]);
    expect(all.cursor).toBe(3);
    expect(all.firstSeq).toBe(1);

    const tail = j.after(2);
    expect(tail.events.map((e) => e.message)).toEqual(["c"]);
    expect(tail.cursor).toBe(3);
  });

  it("returns an empty batch when the cursor is up to date", () => {
    const j = new RuntimeEventJournal();
    j.append({ type: "log.written", message: "a" });
    const batch = j.after(1);
    expect(batch.events).toEqual([]);
    expect(batch.cursor).toBe(1);
  });

  it("evicts FIFO past the cap, advancing firstSeq", () => {
    const j = new RuntimeEventJournal(2);
    j.append({ type: "log.written", message: "a" });
    j.append({ type: "log.written", message: "b" });
    j.append({ type: "log.written", message: "c" });
    const batch = j.after(0);
    // First entry (seq 1) evicted; seq 2,3 retained.
    expect(batch.events.map((e) => e.message)).toEqual(["b", "c"]);
    expect(batch.firstSeq).toBe(2);
  });
});

describe("journalRuntimeToolDefs — single-execution wrap", () => {
  it("journals the canonical event and strips the events sub-key from the result", async () => {
    const j = new RuntimeEventJournal();
    const [logDef] = journalRuntimeToolDefs(buildRuntimeToolDefs({ runtimeTools: ["log"] }), j);

    const result = await logDef!.handler({ level: "info", message: "hi" });

    // Event landed in the journal…
    const batch = j.after(0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ type: "log.written", level: "info", message: "hi" });
    // …and no longer rides in the result _meta (sub-key removed).
    expect(result._meta?.[RUNTIME_TOOL_EVENTS_META_KEY]).toBeUndefined();
    // The tool's text content still reaches the model.
    expect(result.content?.[0]).toMatchObject({ type: "text" });
  });
});

describe("GET /runtime-events", () => {
  const okHost = { Host: "sidecar" };

  it("serves events after the cursor when a journal is wired", async () => {
    const journal = new RuntimeEventJournal();
    journal.append({ type: "log.written", message: "one" });
    const app = createApp(makeDeps({ runtimeEventJournal: journal }));

    const res = await app.request("/runtime-events?after=0", { headers: okHost });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ message: string }>; cursor: number };
    expect(body.events.map((e) => e.message)).toEqual(["one"]);
    expect(body.cursor).toBe(1);
  });

  it("answers an empty batch when no journal is wired", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/runtime-events?after=0", { headers: okHost });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { events: unknown[] }).events).toEqual([]);
  });

  it("rejects a foreign Host header (same posture as /mcp)", async () => {
    const app = createApp(makeDeps({ runtimeEventJournal: new RuntimeEventJournal() }));
    const res = await app.request("/runtime-events?after=0", { headers: { Host: "evil.example" } });
    expect(res.status).toBe(403);
  });
});
