// SPDX-License-Identifier: Apache-2.0

/**
 * The harness tools `output` and `publish_file`, driven through the Pi tool
 * each extension registers: a valid call emits its canonical run event (with a
 * numeric `timestamp`) and replies; a refused call throws, Pi's tool-error
 * signal, and emits nothing.
 */

import { beforeEach, describe, it, expect } from "bun:test";
import {
  buildOutputExtension,
  buildPublishFileExtension,
  filePublishedEvent,
  type HarnessToolEvent,
  type PublishedFile,
} from "../src/harness-tools.ts";
import type { ExtensionFactory } from "../src/pi-sdk.ts";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

const emitted: HarnessToolEvent[] = [];
const emit = (event: HarnessToolEvent): void => {
  emitted.push(event);
};
beforeEach(() => {
  emitted.length = 0;
});

/** Run an extension factory against a stub Pi and return the tool it registered. */
function registered(factory: ExtensionFactory): RegisteredTool {
  const tools: RegisteredTool[] = [];
  factory({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as never);
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

const output = (schema: Record<string, unknown>) => registered(buildOutputExtension(schema, emit));

const publishedFile: PublishedFile = {
  id: "file_primary",
  uri: "appfile://file_primary",
  name: "Final report.html",
  mime: "text/html",
  size: 42,
  sha256: "abc123",
};

describe("harness tool events", () => {
  // Every emitted canonical event MUST carry a numeric `timestamp`: the
  // reducer copies it into RunResult, where the finalize endpoint requires a
  // number.
  it("stamps a numeric timestamp on every emitted event", async () => {
    const publish = registered(buildPublishFileExtension(async () => publishedFile, emit));
    for (const [tool, args] of [
      [output({ type: "object" }), { data: { ok: true } }],
      [publish, { path: "a.txt" }],
    ] as const) {
      emitted.length = 0;
      await tool.execute("call-1", args);
      expect(emitted).toHaveLength(1);
      expect(typeof emitted[0]!.timestamp).toBe("number");
    }
  });
});

describe("output — schema exposure", () => {
  it("is named output and advertises the declared schema as the `data` argument", () => {
    const tool = output({
      type: "object",
      properties: {
        total: { type: "number", description: "Total count" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["total", "items"],
    });
    expect(tool.name).toBe("output");
    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties.total.type).toBe("number");
    expect(dataSchema.properties.items.type).toBe("array");
    expect(dataSchema.required).toEqual(["total", "items"]);
  });

  it("preserves the output schema description, defaulting when absent", () => {
    const withDesc = output({
      type: "object",
      description: "Customer order summary",
      properties: { orderId: { type: "string" } },
    });
    expect(withDesc.parameters.properties.data.description).toBe("Customer order summary");

    const noDesc = output({ type: "object", properties: { count: { type: "number" } } });
    expect(noDesc.parameters.properties.data.description).toBe(
      "JSON object to return as the run output",
    );
  });

  it("tells the agent to call it exactly once (call contract)", () => {
    expect(output({ type: "object" }).description).toContain("Call exactly once");
  });
});

describe("output — validation", () => {
  it("refuses empty data when required fields are declared, without emitting", async () => {
    const tool = output({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    await expect(tool.execute("call-1", { data: {} })).rejects.toThrow(
      /validation failed[\s\S]*name/,
    );
    expect(emitted).toHaveLength(0);
  });

  it("refuses type mismatches", async () => {
    const tool = output({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    await expect(tool.execute("call-1", { data: { count: "not a number" } })).rejects.toThrow(
      "validation failed",
    );
  });

  it("accepts valid data and emits output.emitted", async () => {
    const tool = output({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
    const result = await tool.execute("call-1", { data: { name: "Ada", age: 36 } });
    expect(result.content[0]!.text).toBe("Output recorded");
    expect(emitted).toEqual([
      { type: "output.emitted", data: { name: "Ada", age: 36 }, timestamp: expect.any(Number) },
    ]);
  });
});

describe("output — schema dialect and compile failure", () => {
  // The in-container check pre-empts the server's post-hoc `validateOutput`,
  // so both sides must speak the same dialect: JSON Schema 2020-12.
  it("compiles a 2020-12-only schema and enforces it", async () => {
    const tool = output({
      type: "object",
      properties: {
        pair: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          minItems: 2,
        },
      },
      required: ["pair"],
    });

    await expect(tool.execute("call-1", { data: { pair: [1, "x"] } })).rejects.toThrow(
      "validation failed",
    );
    await tool.execute("call-2", { data: { pair: ["x", 1] } });
    expect(emitted).toHaveLength(1);
  });

  it("refuses every output when the declared schema cannot compile", async () => {
    const tool = output({
      type: "object",
      properties: { n: { type: "not-a-json-schema-type" } },
    });
    await expect(tool.execute("call-1", { data: { anything: true } })).rejects.toThrow(
      "cannot be compiled",
    );
    expect(emitted).toHaveLength(0);
  });

  it("compiles two schemas carrying the same $id in one process", async () => {
    const schema = {
      $id: "https://example.test/out.json",
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    for (const tool of [output({ ...schema }), output({ ...schema })]) {
      await expect(tool.execute("call-1", { data: { n: "nope" } })).rejects.toThrow(
        "validation failed",
      );
      await tool.execute("call-2", { data: { n: 1 } });
    }
    expect(emitted).toHaveLength(2);
  });
});

describe("publish_file", () => {
  /** The tool around an uploader that records each `(path, name)` it receives. */
  function publishRecording() {
    const requests: Array<[string, string | undefined]> = [];
    const tool = registered(
      buildPublishFileExtension(async (path, name) => {
        requests.push([path, name]);
        return publishedFile;
      }, emit),
    );
    return { tool, requests };
  }

  it("is named publish_file and declares only `path` and `name`", () => {
    const { tool } = publishRecording();
    expect(tool.name).toBe("publish_file");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["name", "path"]);
    expect(tool.parameters.required).toEqual(["path"]);
    expect(tool.description).toContain("appfile://");
    expect(tool.description).toContain("./outputs/");
  });

  it("uploads with (path, name) and emits file.published", async () => {
    const { tool, requests } = publishRecording();
    const result = await tool.execute("call-1", {
      path: "outputs/final.html",
      name: "Final report.html",
    });
    expect(result.content[0]!.text).toBe("Published Final report.html → appfile://file_primary");
    expect(requests).toEqual([["outputs/final.html", "Final report.html"]]);
    expect(emitted).toEqual([
      { ...filePublishedEvent(publishedFile), timestamp: expect.any(Number) },
    ]);
  });

  it("builds the file.published event from the stored file", () => {
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

  it("ignores an undeclared argument instead of refusing the call", async () => {
    const { tool, requests } = publishRecording();
    await tool.execute("call-1", { path: "outputs/final.html", extra: "x" });
    expect(requests).toEqual([["outputs/final.html", undefined]]);
    expect(emitted).toHaveLength(1);
  });

  it("normalizes an empty `name` to undefined on the way to the uploader", async () => {
    // A model with nothing better to send fills the optional field with "";
    // the uploader then falls back to the on-disk file name.
    const { tool, requests } = publishRecording();
    await tool.execute("call-1", { path: "outputs/notes.md", name: "" });
    expect(requests).toEqual([["outputs/notes.md", undefined]]);
  });

  it("refuses a missing path", async () => {
    const { tool, requests } = publishRecording();
    await expect(tool.execute("call-1", {})).rejects.toThrow("non-empty `path`");
    expect(requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("refuses the call with the upload's failure", async () => {
    const tool = registered(
      buildPublishFileExtension(async () => {
        throw new Error("quota exceeded");
      }, emit),
    );
    await expect(tool.execute("call-1", { path: "a.txt" })).rejects.toThrow(
      "Failed to publish 'a.txt': quota exceeded",
    );
    expect(emitted).toHaveLength(0);
  });
});
