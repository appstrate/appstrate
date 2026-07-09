// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-side `api_call` response shaper:
 *   - `responseMode.toFile` writes the body to a workspace path and returns
 *     a `{ kind:"file", path, size, status, sha256 }` descriptor (inline
 *     body and `resource_link` body both).
 *   - without `toFile`, the upstream status is prepended so the LLM sees it.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPSTREAM_META_KEY } from "@appstrate/mcp-transport";
import { shapeApiCallResponse } from "../mcp/api-call-response-resolver.ts";

// `realpathSync`: on macOS `tmpdir()` is `/var/folders/…`, a symlink to
// `/private/var/folders/…`. `writeBodyConfined` resolves the target's parent
// with `realpath` before comparing it to the workspace root, so an unresolved
// root makes every write look like a symlink escape. Real runs mount a real
// directory; only the fixture needs this.
const ws = () => realpathSync(mkdtempSync(join(tmpdir(), "apicall-resp-")));
const noop = () => {};
const baseOpts = (workspace: string, toFile?: string) => ({
  workspace,
  ...(toFile ? { toFile } : {}),
  toolCallId: "tc",
  runId: "run",
  emit: noop,
  readResource: async (uri: string) => ({ contents: [{ uri, text: "" }] }),
});

type Block = { type: string; text?: string; uri?: string };
const withStatus = (content: Block[], status: number) => ({
  content,
  _meta: { [UPSTREAM_META_KEY]: { status, headers: {} } },
});

describe("shapeApiCallResponse — responseMode.toFile", () => {
  it("writes an inline text body to the path and returns a file descriptor", async () => {
    const workspace = ws();
    const result = withStatus([{ type: "text", text: '{"a":1}' }], 200);
    const out = await shapeApiCallResponse(result, baseOpts(workspace, "out.json"));
    const descriptor = JSON.parse((out.content[0] as { text: string }).text);
    expect(descriptor.kind).toBe("file");
    expect(descriptor.path).toBe("out.json");
    expect(descriptor.size).toBe(7);
    expect(descriptor.status).toBe(200);
    expect(descriptor.sha256).toBeUndefined();
    expect(readFileSync(join(workspace, "out.json"), "utf8")).toBe('{"a":1}');
  });

  it("emits the descriptor as structuredContent alongside the JSON text fallback", async () => {
    const workspace = ws();
    const result = withStatus([{ type: "text", text: '{"a":1}' }], 200);
    const out = await shapeApiCallResponse(result, baseOpts(workspace, "out.json"));
    // Same payload twice per the MCP spec recommendation: machine-readable
    // structuredContent (matches the tool's outputSchema) + text fallback.
    expect(out.structuredContent).toEqual({
      kind: "file",
      path: "out.json",
      size: 7,
      status: 200,
    });
    expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual(out.structuredContent);
  });

  it("resolves a resource_link body via readResource before writing", async () => {
    const workspace = ws();
    const result = withStatus([{ type: "resource_link", uri: "appstrate://blob/1" }], 200);
    const opts = {
      ...baseOpts(workspace, "t.json"),
      readResource: async (uri: string) => ({ contents: [{ uri, text: "BIGTRANSCRIPT" }] }),
    };
    await shapeApiCallResponse(result, opts);
    expect(readFileSync(join(workspace, "t.json"), "utf8")).toBe("BIGTRANSCRIPT");
  });

  it("carries the upstream status (incl. errors) into the descriptor + preserves isError", async () => {
    const workspace = ws();
    const result = { ...withStatus([{ type: "text", text: "not found" }], 404), isError: true };
    const out = await shapeApiCallResponse(result, baseOpts(workspace, "e.json"));
    const descriptor = JSON.parse((out.content[0] as { text: string }).text);
    expect(descriptor.status).toBe(404);
    expect(out.isError).toBe(true);
  });
});

describe("shapeApiCallResponse — no toFile (status surfacing)", () => {
  it("prepends an [api_call status=N] line to the content", async () => {
    const workspace = ws();
    const result = withStatus([{ type: "text", text: "hi" }], 404);
    const out = await shapeApiCallResponse(result, baseOpts(workspace));
    expect((out.content[0] as { text: string }).text).toBe("[api_call status=404]");
    expect((out.content[1] as { text: string }).text).toBe("hi");
  });

  // #876: the sidecar attaches no structuredContent on the inline path, so the
  // body stays the sole payload. Shaping must not invent one either — a
  // structuredContent-preferring client would surface it instead of the body.
  it("emits no structuredContent on the inline path, leaving the body in content", async () => {
    const workspace = ws();
    const result = withStatus([{ type: "text", text: '{"files":[]}' }], 200);
    const out = await shapeApiCallResponse(result, baseOpts(workspace));
    expect(out.structuredContent).toBeUndefined();
    expect((out.content[1] as { text: string }).text).toBe('{"files":[]}');
  });

  it("leaves the result unchanged when no upstream _meta is present", async () => {
    const workspace = ws();
    const result = { content: [{ type: "text", text: "hi" }] as Block[] };
    const out = await shapeApiCallResponse(result, baseOpts(workspace));
    expect(out.content).toHaveLength(1);
    expect((out.content[0] as { text: string }).text).toBe("hi");
  });
});
