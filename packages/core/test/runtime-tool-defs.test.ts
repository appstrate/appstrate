// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildRuntimeToolDefs,
  reEmitRuntimeToolEvents,
  RUNTIME_TOOL_EVENTS_META_KEY,
  type RuntimeToolEvent,
} from "../src/runtime-tool-defs.ts";

function defsByName(runtimeTools: string[]) {
  const defs = buildRuntimeToolDefs({ runtimeTools });
  return new Map(defs.map((d) => [d.descriptor.name, d]));
}

function eventsOf(meta: Record<string, unknown> | undefined): RuntimeToolEvent[] {
  const raw = meta?.[RUNTIME_TOOL_EVENTS_META_KEY];
  return Array.isArray(raw) ? (raw as RuntimeToolEvent[]) : [];
}

describe("buildRuntimeToolDefs — selection", () => {
  it("returns only the selected tools, de-duplicated, ignoring unknowns", () => {
    const defs = buildRuntimeToolDefs({ runtimeTools: ["log", "note", "log", "bogus"] });
    expect(defs.map((d) => d.descriptor.name)).toEqual(["log", "note"]);
  });

  it("returns nothing when no tools are selected", () => {
    expect(buildRuntimeToolDefs({})).toHaveLength(0);
    expect(buildRuntimeToolDefs({ runtimeTools: [] })).toHaveLength(0);
  });
});

describe("buildRuntimeToolDefs — event payloads", () => {
  it("log emits log.written with level + message", async () => {
    const def = defsByName(["log"]).get("log")!;
    const result = await def.handler({ level: "info", message: "hello" });
    expect(eventsOf(result._meta)).toEqual([
      { type: "log.written", level: "info", message: "hello", timestamp: expect.any(Number) },
    ]);
  });

  it("note emits memory.added, including scope only when set", async () => {
    const def = defsByName(["note"]).get("note")!;
    expect(eventsOf((await def.handler({ content: "x" }))._meta)).toEqual([
      { type: "memory.added", content: "x", timestamp: expect.any(Number) },
    ]);
    expect(eventsOf((await def.handler({ content: "y", scope: "shared" }))._meta)).toEqual([
      { type: "memory.added", content: "y", scope: "shared", timestamp: expect.any(Number) },
    ]);
  });

  it("pin emits pinned.set keyed by slot", async () => {
    const def = defsByName(["pin"]).get("pin")!;
    const result = await def.handler({ key: "checkpoint", content: { step: 2 } });
    expect(eventsOf(result._meta)).toEqual([
      {
        type: "pinned.set",
        key: "checkpoint",
        content: { step: 2 },
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("report remains available as a deprecated compatibility emitter", async () => {
    const def = defsByName(["report"]).get("report")!;
    expect(def.descriptor.description).toContain("Deprecated compatibility");
    const result = await def.handler({ content: "# Legacy report" });
    expect(eventsOf(result._meta)).toEqual([
      {
        type: "report.appended",
        content: "# Legacy report",
        timestamp: expect.any(Number),
      },
    ]);
  });

  // Regression (#run_300c5118): every emitted canonical event MUST carry a
  // numeric `timestamp`. The reducer copies it into RunResult.logs, where the
  // finalize endpoint requires a number — an undefined timestamp failed the
  // whole run over the sidecar/MCP re-emit path.
  it("stamps a numeric timestamp on every emitted event", async () => {
    for (const name of ["log", "note", "pin", "report", "output"]) {
      const def = defsByName([name]).get(name)!;
      const args =
        name === "pin"
          ? { key: "k", content: 1 }
          : name === "output"
            ? { data: { ok: true } }
            : name === "log"
              ? { level: "info", message: "m" }
              : { content: "c" };
      const events = eventsOf((await def.handler(args))._meta);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(typeof e.timestamp).toBe("number");
    }
  });
});

describe("reEmitRuntimeToolEvents", () => {
  it("re-emits each well-formed event from the meta key", () => {
    const emitted: RuntimeToolEvent[] = [];
    reEmitRuntimeToolEvents(
      { [RUNTIME_TOOL_EVENTS_META_KEY]: [{ type: "log.written", message: "a" }, { bad: 1 }] },
      (e) => emitted.push(e),
    );
    expect(emitted).toEqual([{ type: "log.written", message: "a" }]);
  });

  it("is a no-op when the meta key is absent or malformed", () => {
    const emitted: RuntimeToolEvent[] = [];
    reEmitRuntimeToolEvents(undefined, (e) => emitted.push(e));
    reEmitRuntimeToolEvents({ [RUNTIME_TOOL_EVENTS_META_KEY]: "nope" }, (e) => emitted.push(e));
    expect(emitted).toHaveLength(0);
  });
});
