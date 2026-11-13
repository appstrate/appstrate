// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildPublishFileDef,
  buildOutputToolDef,
  CANONICAL_RUNTIME_TOOL_EVENT_TYPES,
  filePublishedEvent,
  reEmitRuntimeToolEvents,
  RUNTIME_TOOL_EVENTS_META_KEY,
  type PublishedFile,
  type RuntimeToolEvent,
} from "../src/runtime-tool-defs.ts";

function eventsOf(meta: Record<string, unknown> | undefined): RuntimeToolEvent[] {
  const raw = meta?.[RUNTIME_TOOL_EVENTS_META_KEY];
  return Array.isArray(raw) ? (raw as RuntimeToolEvent[]) : [];
}

describe("runtime tool events", () => {
  // Every emitted canonical event MUST carry a numeric `timestamp`: the
  // reducer copies it into RunResult, where the finalize endpoint requires a
  // number.
  it("stamps a numeric timestamp on every emitted event", async () => {
    const output = buildOutputToolDef({ type: "object" });
    const publish = buildPublishFileDef(async () => ({
      id: "file_1",
      uri: "appfile://file_1",
      name: "a.txt",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
    }));
    for (const [def, args] of [
      [output, { data: { ok: true } }],
      [publish, { path: "a.txt" }],
    ] as const) {
      const events = eventsOf((await def.handler(args))._meta);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(typeof e.timestamp).toBe("number");
    }
  });

  it("accepts only the events of the runner's own tools", () => {
    expect([...CANONICAL_RUNTIME_TOOL_EVENT_TYPES]).toEqual(["output.emitted", "file.published"]);
  });
});

describe("reEmitRuntimeToolEvents", () => {
  it("re-emits each well-formed event from the meta key", () => {
    const emitted: RuntimeToolEvent[] = [];
    reEmitRuntimeToolEvents(
      {
        [RUNTIME_TOOL_EVENTS_META_KEY]: [
          { type: "output.emitted", data: { a: 1 } },
          { bad: 1 },
          { type: "log.written", message: "a" },
        ],
      },
      (e) => emitted.push(e),
    );
    expect(emitted).toEqual([{ type: "output.emitted", data: { a: 1 } }]);
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
    id: "file_primary",
    uri: "appfile://file_primary",
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
      fileId: "file_primary",
      uri: "appfile://file_primary",
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
          { type: "document.published", document_id: "file_legacy" },
          { type: "file.published", fileId: "file_new" },
          { type: "forged.event", x: 1 },
        ],
      },
      (e) => emitted.push(e),
    );
    expect(emitted).toEqual([{ type: "file.published", fileId: "file_new" }]);
  });
});

describe("output — schema dialect and compile failure", () => {
  /**
   * The in-container check exists to pre-empt the server's post-hoc
   * `validateOutput`. It can only do that if both sides speak the SAME
   * dialect. This used to be a private draft-07 Ajv with no ajv-formats
   * beside the server's shared Ajv2020; a 2020-12 keyword compiled on one
   * side and not the other.
   */
  it("compiles a 2020-12-only schema and enforces it", async () => {
    const def = buildOutputToolDef({
      type: "object",
      properties: {
        pair: {
          type: "array",
          // `prefixItems` is 2020-12. Draft-07 does not know it and treats
          // it as an unknown annotation, so this constraint vanished.
          prefixItems: [{ type: "string" }, { type: "number" }],
          minItems: 2,
        },
      },
      required: ["pair"],
    });

    const bad = await def.handler({ data: { pair: [1, "x"] } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ text: expect.stringContaining("validation failed") });

    const good = await def.handler({ data: { pair: ["x", 1] } });
    expect(good.isError).toBeUndefined();
  });

  /**
   * A schema that cannot compile used to set `validator = null`, and the guard
   * was `if (validator && !validator(data))` — so EVERY payload was accepted,
   * silently, and the run failed later at the server check this tool exists to
   * pre-empt.
   */
  it("refuses every output when the declared schema cannot compile", async () => {
    const def = buildOutputToolDef({
      type: "object",
      properties: { n: { type: "not-a-json-schema-type" } },
    });

    const res = await def.handler({ data: { anything: true } });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({
      text: expect.stringContaining("cannot be compiled"),
    });
  });

  /**
   * Regression guard for the second half of the private-instance bug: it never
   * called `removeSchema`, so compiling two schemas carrying the same `$id` in
   * one process threw "schema with key or id … already exists" — caught, and
   * turned into the silent accept-everything above.
   */
  it("compiles two schemas carrying the same $id in one process", async () => {
    const schema = {
      $id: "https://example.test/out.json",
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const first = buildOutputToolDef({ ...schema });
    const second = buildOutputToolDef({ ...schema });

    for (const def of [first, second]) {
      expect((await def.handler({ data: { n: "nope" } })).isError).toBe(true);
      expect((await def.handler({ data: { n: 1 } })).isError).toBeUndefined();
    }
  });
});
