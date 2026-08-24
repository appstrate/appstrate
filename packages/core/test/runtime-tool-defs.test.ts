// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildPublishFileDef,
  buildRuntimeToolDefs,
  CANONICAL_RUNTIME_TOOL_EVENT_TYPES,
  filePublishedEvent,
  reEmitRuntimeToolEvents,
  RUNTIME_TOOL_EVENTS_META_KEY,
  type PublishedFile,
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

  // A manifest persisted before a runtime tool was retired (or one carrying a
  // plain typo) must never break the run: the builder skips ids it cannot
  // build and keeps the rest of the selection.
  it("silently skips retired/unknown ids while keeping the valid ones", () => {
    const built = defsByName(["report", "log", "not-a-tool"]);
    expect([...built.keys()]).toEqual(["log"]);
  });

  // Regression (#run_300c5118): every emitted canonical event MUST carry a
  // numeric `timestamp`. The reducer copies it into RunResult.logs, where the
  // finalize endpoint requires a number — an undefined timestamp failed the
  // whole run over the sidecar/MCP re-emit path.
  it("stamps a numeric timestamp on every emitted event", async () => {
    for (const name of ["log", "note", "pin", "output"]) {
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

describe("buildPublishFileDef", () => {
  const publishedFile: PublishedFile = {
    id: "doc_primary",
    uri: "appfile://doc_primary",
    name: "Final report.html",
    mime: "text/html",
    size: 42,
    sha256: "abc123",
  };

  it("declares only `path` and `name`, and says nothing about how files are displayed", () => {
    const def = buildPublishFileDef(async () => publishedFile);
    const schema = def.descriptor.inputSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(properties).sort()).toEqual(["name", "path"]);
    expect(schema.required).toEqual(["path"]);
    // The retired `presentation` concept must not resurface anywhere in the
    // tool surface — the model no longer decides anything about presentation.
    expect(JSON.stringify(schema)).not.toContain("presentation");
    expect(def.descriptor.description).not.toContain("presentation");
    expect(def.descriptor.description).not.toMatch(/primary/i);
    // What the description must still carry.
    expect(def.descriptor.description).toContain("appfile://");
    expect(def.descriptor.description).toContain("./outputs/");
  });

  it("uploads with (path, name) only", async () => {
    const requests: Array<[string, string | undefined]> = [];
    const def = buildPublishFileDef(async (path, name) => {
      requests.push([path, name]);
      return publishedFile;
    });

    const result = await def.handler({
      path: "outputs/final.html",
      name: "Final report.html",
    });

    expect(requests).toEqual([["outputs/final.html", "Final report.html"]]);
    expect(eventsOf(result._meta)).toEqual([
      {
        ...filePublishedEvent(publishedFile),
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("emits a file.published event with no presentation field", () => {
    expect(filePublishedEvent(publishedFile)).toEqual({
      type: "file.published",
      file_id: "doc_primary",
      uri: "appfile://doc_primary",
      name: "Final report.html",
      mime: "text/html",
      size: 42,
      sha256: "abc123",
    });
  });

  it("IGNORES a retired `presentation` argument instead of rejecting the call", async () => {
    // Version skew: an agent running against a cached manifest (or an older
    // system prompt) may still pass `presentation`. The deliverable must be
    // published anyway — a retired argument is never an error.
    const requests: Array<[string, string | undefined]> = [];
    const def = buildPublishFileDef(async (path, name) => {
      requests.push([path, name]);
      return publishedFile;
    });

    const result = await def.handler({
      path: "outputs/final.html",
      presentation: "primary",
    });

    expect(result.isError).toBeUndefined();
    expect(requests).toEqual([["outputs/final.html", undefined]]);
    expect(eventsOf(result._meta)).toHaveLength(1);
  });

  it("normalizes an empty `name` to undefined on the way to the uploader", async () => {
    // A model that has nothing better to send fills the optional field with the
    // empty string rather than omitting it. `""` must reach the uploader as
    // `undefined` so the uploader falls back to the on-disk file name; passing
    // `""` through names the deliverable the empty string.
    const requests: Array<[string, string | undefined]> = [];
    const def = buildPublishFileDef(async (path, name) => {
      requests.push([path, name]);
      return publishedFile;
    });

    const result = await def.handler({ path: "outputs/notes.md", name: "" });

    expect(result.isError).toBeUndefined();
    expect(requests).toEqual([["outputs/notes.md", undefined]]);
  });

  it("still rejects a missing path", async () => {
    const def = buildPublishFileDef(async () => publishedFile);
    const result = await def.handler({ presentation: "primary" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("non-empty `path`");
  });

  it("is named publish_file and never mentions the retired vocabulary", () => {
    const def = buildPublishFileDef(async () => publishedFile);
    expect(def.descriptor.name).toBe("publish_file");
    expect(def.descriptor.description).not.toContain("publish_document");
    expect(def.descriptor.description).not.toContain("document://");
  });
});

describe("run-event type compatibility (#1177)", () => {
  it("file.published is canonical and document.published is no longer accepted", () => {
    expect([...CANONICAL_RUNTIME_TOOL_EVENT_TYPES]).toContain("file.published");
    expect([...CANONICAL_RUNTIME_TOOL_EVENT_TYPES]).not.toContain("document.published" as never);

    // The only producer of the retired name is this module's own
    // `filePublishedEvent`, bundled into the SAME artifact as the acceptor
    // below — there is no version boundary between them, so the name can now
    // only arrive forged, and the acceptor drops it like any other.
    const emitted: unknown[] = [];
    reEmitRuntimeToolEvents(
      {
        [RUNTIME_TOOL_EVENTS_META_KEY]: [
          { type: "document.published", document_id: "doc_legacy" },
          { type: "file.published", file_id: "doc_new" },
          { type: "forged.event", x: 1 },
        ],
      },
      (e) => emitted.push(e),
    );
    expect(emitted).toEqual([{ type: "file.published", file_id: "doc_new" }]);
  });
});
