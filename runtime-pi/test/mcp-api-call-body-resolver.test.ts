// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-side `api_call` body resolver:
 *
 *   - `resolveApiCallBody` turns `{ fromFile }` (raw body) and multipart
 *     `{ name, fromFile }` file-parts into the sidecar's canonical wire
 *     shapes, passes through strings / `{ fromBytes }` / text parts, and
 *     enforces path safety + the request-body size cap.
 *   - `augmentApiCallInputSchema` advertises the `{ fromFile }` variants
 *     to the LLM and degrades gracefully on an unexpected schema shape.
 *   - `isApiCallToolName` recognises single- and multi-auth api_call
 *     tool names.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveApiCallBody,
  augmentApiCallInputSchema,
  ApiCallBodyResolveError,
} from "../mcp/api-call-body-resolver.ts";

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "apicall-body-"));
}

function writeFile(ws: string, name: string, bytes: Uint8Array | string): void {
  writeFileSync(join(ws, name), bytes);
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("resolveApiCallBody", () => {
  it("passes through string / null / undefined bodies", async () => {
    const ws = freshWorkspace();
    expect(await resolveApiCallBody("hello", { workspace: ws })).toBe("hello");
    expect(await resolveApiCallBody(null, { workspace: ws })).toBe(null);
    expect(await resolveApiCallBody(undefined, { workspace: ws })).toBe(undefined);
  });

  it("passes through an already-canonical { fromBytes } body", async () => {
    const ws = freshWorkspace();
    const body = { fromBytes: b64("x"), encoding: "base64" };
    expect(await resolveApiCallBody(body, { workspace: ws })).toEqual(body);
  });

  it("resolves { fromFile } to { fromBytes, encoding }", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "payload.json", '{"a":1}');
    const out = await resolveApiCallBody({ fromFile: "payload.json" }, { workspace: ws });
    expect(out).toEqual({ fromBytes: b64('{"a":1}'), encoding: "base64" });
  });

  it("resolves a multipart { name, fromFile } file part, defaulting filename to basename", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "report.md", "# Title");
    const out = (await resolveApiCallBody(
      { multipart: [{ name: "file", fromFile: "report.md" }] },
      { workspace: ws },
    )) as { multipart: unknown[] };
    expect(out.multipart[0]).toEqual({
      name: "file",
      filename: "report.md",
      bytes: b64("# Title"),
      encoding: "base64",
    });
  });

  it("preserves explicit filename + contentType on a multipart file part", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "doc.bin", "data");
    const out = (await resolveApiCallBody(
      {
        multipart: [
          { name: "f", fromFile: "doc.bin", filename: "custom.txt", contentType: "text/plain" },
        ],
      },
      { workspace: ws },
    )) as { multipart: Array<Record<string, unknown>> };
    expect(out.multipart[0]!.filename).toBe("custom.txt");
    expect(out.multipart[0]!.contentType).toBe("text/plain");
  });

  it("passes through multipart text parts untouched", async () => {
    const ws = freshWorkspace();
    const out = (await resolveApiCallBody(
      { multipart: [{ name: "field", value: "v" }] },
      { workspace: ws },
    )) as { multipart: unknown[] };
    expect(out.multipart[0]).toEqual({ name: "field", value: "v" });
  });

  it("renames an afps inline { fromBytes } part to the sidecar file-part shape", async () => {
    const ws = freshWorkspace();
    const out = (await resolveApiCallBody(
      { multipart: [{ name: "blob", fromBytes: b64("z"), encoding: "base64" }] },
      { workspace: ws },
    )) as { multipart: Array<Record<string, unknown>> };
    expect(out.multipart[0]).toEqual({
      name: "blob",
      filename: "blob",
      bytes: b64("z"),
      encoding: "base64",
    });
  });

  it("rejects a { fromFile } body over the size cap", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "big.bin", "0123456789ABCDEF"); // 16 bytes
    await expect(
      resolveApiCallBody({ fromFile: "big.bin" }, { workspace: ws, maxBytes: 8 }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("rejects when multipart file parts sum over the size cap", async () => {
    const ws = freshWorkspace();
    writeFile(ws, "a.bin", "aaaaa"); // 5
    writeFile(ws, "b.bin", "bbbbb"); // 5
    await expect(
      resolveApiCallBody(
        {
          multipart: [
            { name: "a", fromFile: "a.bin" },
            { name: "b", fromFile: "b.bin" },
          ],
        },
        { workspace: ws, maxBytes: 8 },
      ),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("rejects a missing file with a structured error", async () => {
    const ws = freshWorkspace();
    await expect(
      resolveApiCallBody({ fromFile: "nope.json" }, { workspace: ws }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("refuses a symlinked fromFile (path-safety via resolveSafeFile)", async () => {
    const ws = freshWorkspace();
    // Dangling symlink: resolveSafePath leaves it unresolved (target ENOENT),
    // so resolveSafeFile's `lstat().isSymbolicLink()` gate refuses it before
    // any read — deterministic across platforms (a symlink to an EXISTING
    // target would be realpath-followed and judged purely by containment).
    symlinkSync("/appstrate-test-nonexistent-target", join(ws, "link.txt"));
    await expect(
      resolveApiCallBody({ fromFile: "link.txt" }, { workspace: ws }),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });

  it("refuses a fromFile that escapes the allowed roots", async () => {
    const ws = freshWorkspace();
    // Absolute path under neither the workspace nor `/tmp` (the only extra
    // allowed root) — rejected by containment regardless of whether it
    // exists, so it is stable on both Linux (`/tmp` tmpdir) and macOS
    // (`/var/folders` tmpdir).
    await expect(
      resolveApiCallBody(
        { fromFile: "/appstrate-test-nonexistent-root/secret.txt" },
        { workspace: ws },
      ),
    ).rejects.toBeInstanceOf(ApiCallBodyResolveError);
  });
});

describe("augmentApiCallInputSchema", () => {
  const sidecarSchema = () => ({
    type: "object",
    properties: {
      target: { type: "string" },
      body: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["fromBytes", "encoding"],
            properties: { fromBytes: { type: "string" }, encoding: { const: "base64" } },
          },
          {
            type: "object",
            required: ["multipart"],
            properties: {
              multipart: {
                type: "array",
                items: { oneOf: [{ type: "object" }, { type: "object" }] },
              },
            },
          },
        ],
      },
    },
  });

  it("appends a { fromFile } body variant", () => {
    const aug = augmentApiCallInputSchema(sidecarSchema());
    const oneOf = (aug.properties as { body: { oneOf: Array<Record<string, unknown>> } }).body
      .oneOf;
    expect(oneOf).toHaveLength(4);
    expect((oneOf[3]!.properties as { fromFile?: unknown }).fromFile).toBeDefined();
    expect(oneOf[3]!.required).toEqual(["fromFile"]);
  });

  it("appends a { name, fromFile } multipart file-part variant", () => {
    const aug = augmentApiCallInputSchema(sidecarSchema());
    const oneOf = (aug.properties as { body: { oneOf: Array<Record<string, unknown>> } }).body
      .oneOf;
    const mp = (
      oneOf.find((v) => (v.properties as { multipart?: unknown })?.multipart) as {
        properties: { multipart: { items: { oneOf: Array<Record<string, unknown>> } } };
      }
    ).properties.multipart.items.oneOf;
    expect(mp).toHaveLength(3);
    expect((mp[2]!.properties as { fromFile?: unknown }).fromFile).toBeDefined();
  });

  it("does not mutate the input schema", () => {
    const original = sidecarSchema();
    augmentApiCallInputSchema(original);
    expect((original.properties.body.oneOf as unknown[]).length).toBe(3);
  });

  it("returns the schema unchanged when body is not a oneOf union", () => {
    const schema = { type: "object", properties: { body: { type: "string" } } };
    expect(augmentApiCallInputSchema(schema)).toEqual(schema);
  });

  it("tolerates a null / non-object schema", () => {
    expect(augmentApiCallInputSchema(null)).toEqual({ type: "object", properties: {} });
  });
});
