// SPDX-License-Identifier: Apache-2.0

/**
 * `read_skill`'s projection, with the read injected: what the model gets for
 * `SKILL.md`, a text file, a binary one and an oversized one, and how a refusal
 * or a bad argument comes back. Access itself is the integration suite's.
 */

import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { forbidden } from "../../../../src/lib/errors.ts";
import { buildReadSkillTool } from "../../../../src/modules/mcp/skill-tools.ts";
import { RESOURCE_BLOB_MAX_BYTES } from "../../../../src/modules/mcp/tool-results.ts";
import type { SkillSnapshot } from "../../../../src/services/skill-read.ts";

const noExtra = {} as unknown as AppstrateRequestExtra;

/** The problem body the REST error handler would send for `error`. */
function problem(status: number, code: string, title: string, detail: string) {
  return {
    status,
    body: {
      type: `https://docs.appstrate.dev/errors/${code.replace(/_/g, "-")}`,
      title,
      status,
      detail,
      instance: "urn:appstrate:request:req_test",
      code,
      request_id: "req_test",
    },
  };
}
const encode = (text: string) => new TextEncoder().encode(text);

function snapshot(files: Record<string, Uint8Array>): SkillSnapshot {
  return {
    packageId: "@acme/tone",
    version: "1.2.0",
    definition: "published",
    snapshot: { files, snapshotId: "pv-test" },
  };
}

function tool(read: (id: string) => Promise<SkillSnapshot>) {
  const events: Array<{ status: number }> = [];
  const built = buildReadSkillTool({
    readSkill: read,
    requestId: "req_test",
    observe: (event) => events.push(event),
  });
  return {
    call: (args: Record<string, unknown>) => built.handler(args, noExtra),
    descriptor: built.descriptor,
    events,
  };
}

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

const files = {
  "SKILL.md": encode("---\nname: tone\n---\nBe brief."),
  "scripts/run.sh": encode("echo hi"),
  "assets/logo.bin": new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
};

describe("read_skill", () => {
  it("is a read-only tool taking an id and an optional path, nothing else", () => {
    const { descriptor } = tool(async () => snapshot(files));
    expect(descriptor.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(descriptor.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" }, path: { type: "string" } },
    });
  });

  it("answers SKILL.md, the sorted file list and the version served", async () => {
    const { call, events } = tool(async () => snapshot(files));
    const result = await call({ id: "@acme/tone" });
    expect(result.isError).toBe(false);
    expect(payload(result)).toEqual({
      id: "@acme/tone",
      version: "1.2.0",
      definition: "published",
      content: "---\nname: tone\n---\nBe brief.",
      files: [
        { path: "SKILL.md", size: 28 },
        { path: "assets/logo.bin", size: 4 },
        { path: "scripts/run.sh", size: 7 },
      ],
    });
    expect(events).toMatchObject([{ status: 200 }]);
  });

  it("answers one text file with its content", async () => {
    const { call } = tool(async () => snapshot(files));
    expect(payload(await call({ id: "@acme/tone", path: "scripts/run.sh" }))).toEqual({
      id: "@acme/tone",
      version: "1.2.0",
      definition: "published",
      path: "scripts/run.sh",
      size: 7,
      media_kind: "text",
      content: "echo hi",
    });
  });

  it("answers a small binary file as base64, a larger one as metadata only", async () => {
    const big = new Uint8Array(RESOURCE_BLOB_MAX_BYTES + 1).fill(0xff);
    const { call } = tool(async () => snapshot({ ...files, "assets/big.bin": big }));

    expect(payload(await call({ id: "@acme/tone", path: "assets/logo.bin" }))).toMatchObject({
      media_kind: "binary",
      content_base64: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64"),
    });
    const oversized = payload(await call({ id: "@acme/tone", path: "assets/big.bin" }));
    expect(oversized).toMatchObject({ media_kind: "binary", size: big.byteLength });
    expect(oversized.note).toContain("exceeds the inline size limit");
    expect(oversized).not.toHaveProperty("content_base64");
  });

  it("answers a text file over the inline limit, SKILL.md included, as metadata only", async () => {
    const big = encode("a".repeat(PACKAGE_FILE_INLINE_MAX_BYTES + 1));
    const { call } = tool(async () => snapshot({ "SKILL.md": big, "references/big.md": big }));

    const file = payload(await call({ id: "@acme/tone", path: "references/big.md" }));
    expect(file).toMatchObject({ media_kind: "text", size: big.byteLength });
    expect(file).not.toHaveProperty("content");
    expect(file.note).toContain("exceeds the inline size limit");

    const skill = payload(await call({ id: "@acme/tone" }));
    expect(skill.content).toBeNull();
    expect(skill.note).toContain("exceeds the inline size limit");
  });

  it("answers `content: null` and no note when the tree holds no SKILL.md", async () => {
    const { call } = tool(async () => snapshot({ "scripts/run.sh": encode("echo hi") }));
    const result = payload(await call({ id: "@acme/tone" }));
    expect(result).toMatchObject({ content: null, files: [{ path: "scripts/run.sh", size: 7 }] });
    expect(result).not.toHaveProperty("note");
  });

  it("answers a path the tree does not hold as the REST 404, traversal included", async () => {
    const { call, events } = tool(async () => snapshot(files));
    for (const path of ["missing.md", "../SKILL.md", "/SKILL.md", "__proto__", "toString"]) {
      const result = await call({ id: "@acme/tone", path });
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual(problem(404, "not_found", "Not Found", "File not found"));
    }
    expect(events.every((event) => event.status === 404)).toBe(true);
  });

  it("carries a refusal of the read as a tool error with its REST status", async () => {
    const { call, events } = tool(async () => {
      throw forbidden("Insufficient permissions: skills:read required");
    });
    const result = await call({ id: "@acme/tone" });
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual(
      problem(403, "forbidden", "Forbidden", "Insufficient permissions: skills:read required"),
    );
    expect(events).toMatchObject([{ status: 403 }]);
  });

  it("lets a failure that is not an API answer propagate", async () => {
    const { call } = tool(async () => {
      throw new Error("storage down");
    });
    await expect(call({ id: "@acme/tone" })).rejects.toThrow("storage down");
  });

  it("refuses a missing id or a non-string path as invalid params, before any read", async () => {
    let reads = 0;
    const { call } = tool(async () => {
      reads++;
      return snapshot(files);
    });
    for (const args of [{}, { id: "" }, { id: 3 }, { id: "@acme/tone", path: 1 }]) {
      const refusal = await call(args).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(McpError);
      expect((refusal as McpError).code).toBe(ErrorCode.InvalidParams);
    }
    expect(reads).toBe(0);
  });
});
