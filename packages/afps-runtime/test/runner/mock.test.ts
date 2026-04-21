// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { MockRunner } from "../../src/runner/mock.ts";
import { loadBundleFromBuffer } from "../../src/bundle/loader.ts";
import { SnapshotContextProvider } from "../../src/providers/context/snapshot-provider.ts";
import type { EventSink } from "../../src/interfaces/event-sink.ts";
import type { AfpsEvent } from "../../src/types/afps-event.ts";
import type { RunEvent } from "../../src/types/run-event.ts";
import type { RunResult } from "../../src/types/run-result.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello",
  author: "Acme",
};

function loadRef(prompt = "Run {{runId}}"): ReturnType<typeof loadBundleFromBuffer> {
  const zip = zipSync({
    "manifest.json": enc(JSON.stringify(MANIFEST)),
    "prompt.md": enc(prompt),
  });
  return loadBundleFromBuffer(zip);
}

function collectingSink(): EventSink & {
  events: RunEvent[];
  finalized: RunResult[];
} {
  const events: RunEvent[] = [];
  const finalized: RunResult[] = [];
  return {
    events,
    finalized,
    handle: async (event) => {
      events.push(event);
    },
    finalize: async (r) => {
      finalized.push(r);
    },
  };
}

describe("MockRunner", () => {
  it("emits every scripted event through the sink in arrival order", async () => {
    const events: AfpsEvent[] = [
      { type: "log", level: "info", message: "go" },
      { type: "add_memory", content: "m1" },
      { type: "add_memory", content: "m2" },
    ];
    const sink = collectingSink();
    const runner = new MockRunner({ events });
    await runner.run({
      bundle: loadRef(),
      context: { runId: "r_1", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(sink.events).toHaveLength(3);
    expect(sink.events.every((e) => e.runId === "r_1")).toBe(true);
    expect(sink.events.map((e) => e.type)).toEqual(["log.written", "memory.added", "memory.added"]);
  });

  it("calls sink.finalize exactly once with the aggregated result", async () => {
    const events: AfpsEvent[] = [
      { type: "add_memory", content: "a" },
      { type: "set_state", state: { x: 1 } },
    ];
    const sink = collectingSink();
    await new MockRunner({ events }).run({
      bundle: loadRef(),
      context: { runId: "r", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(sink.finalized).toHaveLength(1);
    expect(sink.finalized[0]!.memories).toHaveLength(1);
    expect(sink.finalized[0]!.state).toEqual({ x: 1 });
  });

  it("renders the prompt template and exposes it via onPromptRendered", async () => {
    let captured: string | undefined;
    await new MockRunner({
      events: [],
      onPromptRendered: (s) => {
        captured = s;
      },
    }).run({
      bundle: loadRef("hello {{runId}}"),
      context: { runId: "r_42", input: {} },
      sink: collectingSink(),
      contextProvider: new SnapshotContextProvider(),
    });
    expect(captured).toContain("hello r_42");
  });

  it("attaches the error to the RunResult when provided", async () => {
    const sink = collectingSink();
    const result = await new MockRunner({
      events: [{ type: "add_memory", content: "x" }],
      error: { message: "adapter failed" },
    }).run({
      bundle: loadRef(),
      context: { runId: "r", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(result.error).toEqual({ message: "adapter failed" });
  });

  it("aborts before emitting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = collectingSink();
    await expect(
      new MockRunner({ events: [{ type: "add_memory", content: "x" }] }).run({
        bundle: loadRef(),
        context: { runId: "r", input: {} },
        sink,
        contextProvider: new SnapshotContextProvider(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(sink.events).toHaveLength(0);
    expect(sink.finalized).toHaveLength(0);
  });

  it("handles an empty event list (no emissions, single finalize)", async () => {
    const sink = collectingSink();
    const result = await new MockRunner({ events: [] }).run({
      bundle: loadRef(),
      context: { runId: "r", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(sink.events).toHaveLength(0);
    expect(sink.finalized).toHaveLength(1);
    expect(result.memories).toHaveLength(0);
    expect(result.state).toBeNull();
  });
});
