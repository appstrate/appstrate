// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for {@link spillResourcesToWorkspace} — materialising embedded MCP
 * resources to workspace files so file bytes never round-trip through the
 * LLM context.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CallToolResult } from "@appstrate/mcp-transport";
import { spillResourcesToWorkspace } from "../src/runtime-tools/resource-spill.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "spill-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("spillResourcesToWorkspace", () => {
  it("passes through results with no resource blocks unchanged", async () => {
    const result: CallToolResult = { content: [{ type: "text", text: "hello" }] };
    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "t1" });
    expect(out).toBe(result);
  });

  it("spills a text resource to a workspace file and replaces it with a pointer", async () => {
    const fileText = "#!/usr/bin/env python3\nprint('hi')\n";
    const result: CallToolResult = {
      content: [
        { type: "text", text: "successfully downloaded text file" },
        {
          type: "resource",
          resource: {
            uri: "repo://owner/repo/sha/abc/contents/scripts/lookup_gencodes.py",
            mimeType: "text/x-python",
            text: fileText,
          },
        },
      ],
    };

    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "toolu_1" });

    // The sibling text block survives; the resource is now a text pointer.
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: "text", text: "successfully downloaded text file" });
    const pointer = out.content[1] as { type: "text"; text: string };
    expect(pointer.type).toBe("text");
    expect(pointer.text).toContain("resources/toolu_1-lookup_gencodes.py");
    expect(pointer.text).toContain("text/x-python");
    expect(pointer.text).toContain("first line");

    // The file exists on disk with the exact bytes — no re-emission needed.
    const written = await fs.readFile(
      path.join(workspace, "resources", "toolu_1-lookup_gencodes.py"),
      "utf-8",
    );
    expect(written).toBe(fileText);
  });

  it("decodes a binary blob resource that the inline renderer would drop", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]); // PNG-ish header
    const blob = Buffer.from(bytes).toString("base64");
    const result: CallToolResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "https://example.com/image.png",
            mimeType: "image/png",
            blob,
          },
        },
      ],
    };

    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "tc2" });

    const pointer = out.content[0] as { type: "text"; text: string };
    expect(pointer.text).toContain("resources/tc2-image.png");
    expect(pointer.text).toContain("image/png");
    expect(pointer.text).not.toContain("first line"); // binary → no text preview

    const written = await fs.readFile(path.join(workspace, "resources", "tc2-image.png"));
    expect(new Uint8Array(written)).toEqual(bytes);
  });

  it("emits a resource.spilled event per materialised file", async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const result: CallToolResult = {
      content: [{ type: "resource", resource: { uri: "x://a/b.txt", text: "data" } }],
    };
    await spillResourcesToWorkspace(result, {
      workspace,
      toolCallId: "tc3",
      runId: "run_x",
      emit: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("resource.spilled");
    expect(events[0]!.path).toBe("resources/tc3-b.txt");
    expect(events[0]!.bytes).toBe(4);
  });

  it("leaves a resource block inline when it carries neither text nor blob", async () => {
    // A malformed resource with only a URI — not expressible in the SDK's
    // strict TextResource|BlobResource union, but possible on the wire.
    const result = {
      content: [{ type: "resource", resource: { uri: "x://empty" } }],
    } as unknown as CallToolResult;
    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "tc4" });
    expect(out.content[0]).toEqual(result.content[0]!);
  });

  it("passes a resource_link through untouched when no readResource fetcher is given", async () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "appstrate://tool-output/run_x/ULID",
          mimeType: "application/json",
        },
      ],
    } as unknown as CallToolResult;
    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "tc5" });
    expect(out).toBe(result);
  });

  it("fetches a resource_link, spills it to a file with a mime-derived extension", async () => {
    const json = JSON.stringify({ user: "Pierre", id: 1045141849 });
    const uri = "appstrate://tool-output/run_x/06F5AZ8FKDQK7CFJVCCYE2Y858";
    const result = {
      content: [{ type: "resource_link", uri, name: "response", mimeType: "application/json" }],
    } as unknown as CallToolResult;

    const out = await spillResourcesToWorkspace(result, {
      workspace,
      toolCallId: "tc6",
      readResource: async (u) => {
        expect(u).toBe(uri);
        return { contents: [{ uri: u, mimeType: "application/json", text: json }] };
      },
    });

    const pointer = out.content[0] as { type: "text"; text: string };
    expect(pointer.type).toBe("text");
    // ULID tail has no extension → derived from mime → `.json` so jq/grep work.
    expect(pointer.text).toContain("resources/tc6-06F5AZ8FKDQK7CFJVCCYE2Y858.json");
    expect(pointer.text).toContain("application/json");

    const written = await fs.readFile(
      path.join(workspace, "resources", "tc6-06F5AZ8FKDQK7CFJVCCYE2Y858.json"),
      "utf-8",
    );
    expect(written).toBe(json);
  });

  it("leaves a resource_link inline when the fetch fails (degraded, not dropped)", async () => {
    const result = {
      content: [
        {
          type: "resource_link",
          uri: "appstrate://tool-output/run_x/Z",
          mimeType: "text/html",
        },
      ],
    } as unknown as CallToolResult;
    const out = await spillResourcesToWorkspace(result, {
      workspace,
      toolCallId: "tc7",
      readResource: async () => {
        throw new Error("resource not found");
      },
    });
    expect(out.content[0]).toEqual(result.content[0]!);
  });

  describe("image blocks", () => {
    // A valid 1x1 PNG — real bytes, so Pi's own sniffer actually runs.
    const PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

    it("writes a PNG byte-exact and keeps it inline, followed by a pointer", async () => {
      const result: CallToolResult = {
        content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
      };
      const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "img1" });

      expect(out.content).toHaveLength(2);
      expect(out.content[0]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
      const pointer = out.content[1] as { type: "text"; text: string };
      expect(pointer.type).toBe("text");
      expect(pointer.text).toContain("resources/img1-image-0.png");
      expect(pointer.text).toContain("image/png");
      expect(pointer.text).toContain(`${PNG_BYTES.byteLength} bytes`);
      expect(pointer.text).toContain("fromFile");

      const written = await fs.readFile(path.join(workspace, "resources", "img1-image-0.png"));
      expect(new Uint8Array(written)).toEqual(PNG_BYTES);
    });

    it("names, labels and points at a mislabelled image by its sniffed mime", async () => {
      const result: CallToolResult = {
        content: [{ type: "image", data: PNG_B64, mimeType: "image/jpeg" }],
      };
      const events: Array<{ type: string; [k: string]: unknown }> = [];
      const out = await spillResourcesToWorkspace(result, {
        workspace,
        toolCallId: "img2",
        emit: (e) => events.push(e),
      });

      expect(out.content[0]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
      const pointer = out.content[1] as { type: "text"; text: string };
      expect(pointer.text).toContain("resources/img2-image-0.png");
      expect(pointer.text).toContain("image/png");
      expect(pointer.text).not.toContain("image/jpeg");
      const written = await fs.readFile(path.join(workspace, "resources", "img2-image-0.png"));
      expect(new Uint8Array(written)).toEqual(PNG_BYTES);
      expect(await fs.readdir(path.join(workspace, "resources"))).toEqual(["img2-image-0.png"]);
      expect(events.map((e) => e.path)).toEqual(["resources/img2-image-0.png"]);
    });

    it("writes an animated PNG but points at it only — Pi's read does not take APNG", async () => {
      // The 1x1 PNG with an `acTL` chunk inserted after IHDR (8 + 25 bytes).
      const actl = Buffer.from([
        0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const apng = Buffer.concat([
        Buffer.from(PNG_BYTES.subarray(0, 33)),
        actl,
        Buffer.from(PNG_BYTES.subarray(33)),
      ]);
      const result: CallToolResult = {
        content: [{ type: "image", data: apng.toString("base64"), mimeType: "image/png" }],
      };
      const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "img7" });

      expect(out.content).toHaveLength(1);
      const pointer = out.content[0] as { type: "text"; text: string };
      expect(pointer.text).toContain("resources/img7-image-0.png");
      expect(pointer.text).toContain("can't be shown inline");
      const written = await fs.readFile(path.join(workspace, "resources", "img7-image-0.png"));
      expect(new Uint8Array(written)).toEqual(new Uint8Array(apng));
    });

    it("turns an empty image into a 0-byte file and a pointer, never an empty inline image", async () => {
      // An empty inline image would reach the provider as an undecodable image
      // and fail the conversation; the pointer keeps the call's trace instead.
      const result: CallToolResult = {
        content: [{ type: "image", data: "", mimeType: "image/png" }],
      };
      const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "img8" });

      expect(out.content).toHaveLength(1);
      const pointer = out.content[0] as { type: "text"; text: string };
      expect(pointer.text).toContain("resources/img8-image-0.png");
      expect(pointer.text).toContain("0 bytes");
      expect(pointer.text).toContain("can't be shown inline");
      const written = await fs.readFile(path.join(workspace, "resources", "img8-image-0.png"));
      expect(written.byteLength).toBe(0);
    });

    it("spills an SVG as a pointer only — Pi cannot show it inline", async () => {
      const result: CallToolResult = {
        content: [
          { type: "image", data: Buffer.from(SVG).toString("base64"), mimeType: "image/svg+xml" },
        ],
      };
      const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "img3" });

      expect(out.content).toHaveLength(1);
      const pointer = out.content[0] as { type: "text"; text: string };
      expect(pointer.type).toBe("text");
      expect(pointer.text).toContain("resources/img3-image-0.svg");
      expect(pointer.text).toContain("can't be shown inline");
      const written = await fs.readFile(
        path.join(workspace, "resources", "img3-image-0.svg"),
        "utf-8",
      );
      expect(written).toBe(SVG);
    });

    it("keeps block order in a mixed result, with non-colliding fallback names", async () => {
      const result = {
        content: [
          { type: "text", text: "before" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
          { type: "resource", resource: { text: "payload", mimeType: "text/plain" } },
          { type: "text", text: "after" },
        ],
      } as unknown as CallToolResult;
      const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "img4" });

      expect(out.content.map((c) => c.type)).toEqual(["text", "image", "text", "text", "text"]);
      expect(out.content[0]).toEqual({ type: "text", text: "before" });
      expect((out.content[2] as { text: string }).text).toContain("resources/img4-image-0.png");
      expect((out.content[3] as { text: string }).text).toContain("resources/img4-resource-1.txt");
      expect(out.content[4]).toEqual({ type: "text", text: "after" });
      expect(
        await fs.readFile(path.join(workspace, "resources", "img4-resource-1.txt"), "utf-8"),
      ).toBe("payload");
    });

    it("leaves the image block untouched when the write fails", async () => {
      // A regular file as the workspace root: nothing can be created under it.
      const notADir = path.join(workspace, "file");
      await fs.writeFile(notADir, "x");
      const result: CallToolResult = {
        content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
      };
      const out = await spillResourcesToWorkspace(result, {
        workspace: notADir,
        toolCallId: "img5",
      });
      expect(out.content).toEqual(result.content);
    });

    it("emits a resource.spilled event for the image", async () => {
      const events: Array<{ type: string; [k: string]: unknown }> = [];
      const result: CallToolResult = {
        content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
      };
      await spillResourcesToWorkspace(result, {
        workspace,
        toolCallId: "img6",
        runId: "run_x",
        emit: (e) => events.push(e),
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("resource.spilled");
      expect(events[0]!.path).toBe("resources/img6-image-0.png");
      expect(events[0]!.bytes).toBe(PNG_BYTES.byteLength);
    });

    describe("one workspace path per spilled block", () => {
      const pointers = (out: CallToolResult) =>
        out.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
      const read = (name: string) => fs.readFile(path.join(workspace, "resources", name));
      const replacing = {
        type: "resource",
        resource: { uri: "file:///image-0.png", mimeType: "image/png", text: "REPLACED" },
      };

      it("keeps an image and a resource named like it apart, image first", async () => {
        const result = {
          content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }, replacing],
        } as unknown as CallToolResult;
        const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "c1" });

        const [imagePointer, resourcePointer] = pointers(out);
        expect(imagePointer).toContain("resources/c1-image-0.png (70 bytes");
        expect(resourcePointer).toContain("resources/c1-image-0-2.png (8 bytes");
        expect(new Uint8Array(await read("c1-image-0.png"))).toEqual(PNG_BYTES);
        expect(await read("c1-image-0-2.png").then(String)).toBe("REPLACED");
      });

      it("keeps a resource and an image named like it apart, resource first", async () => {
        const result = {
          content: [
            { ...replacing, resource: { ...replacing.resource, uri: "file:///image-1.png" } },
            { type: "image", data: PNG_B64, mimeType: "image/png" },
          ],
        } as unknown as CallToolResult;
        const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "c2" });

        const [resourcePointer, imagePointer] = pointers(out);
        expect(resourcePointer).toContain("resources/c2-image-1.png (8 bytes");
        expect(imagePointer).toContain("resources/c2-image-1-2.png (70 bytes");
        expect(await read("c2-image-1.png").then(String)).toBe("REPLACED");
        expect(new Uint8Array(await read("c2-image-1-2.png"))).toEqual(PNG_BYTES);
      });

      it("keeps an image and a fetched resource_link named like it apart", async () => {
        const result = {
          content: [
            { type: "image", data: PNG_B64, mimeType: "image/png" },
            { type: "resource_link", uri: "file:///image-0.png", mimeType: "image/png" },
          ],
        } as unknown as CallToolResult;
        const out = await spillResourcesToWorkspace(result, {
          workspace,
          toolCallId: "c3",
          readResource: async (uri) => ({
            contents: [{ uri, mimeType: "image/png", text: "REPLACED" }],
          }),
        });

        const [imagePointer, linkPointer] = pointers(out);
        expect(imagePointer).toContain("resources/c3-image-0.png (70 bytes");
        expect(linkPointer).toContain("resources/c3-image-0-2.png (8 bytes");
        expect(new Uint8Array(await read("c3-image-0.png"))).toEqual(PNG_BYTES);
        expect(await read("c3-image-0-2.png").then(String)).toBe("REPLACED");
      });

      it("keeps two resources with the same URI basename apart", async () => {
        const result = {
          content: [
            { type: "resource", resource: { uri: "repo://a/README.md", text: "first" } },
            { type: "resource", resource: { uri: "repo://b/README.md", text: "second" } },
          ],
        } as unknown as CallToolResult;
        const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "c4" });

        const [first, second] = pointers(out);
        expect(first).toContain("resources/c4-README.md");
        expect(second).toContain("resources/c4-README-2.md");
        expect(await read("c4-README.md").then(String)).toBe("first");
        expect(await read("c4-README-2.md").then(String)).toBe("second");
      });

      it("does not rename a mislabelled image onto a name already taken", async () => {
        // The resource takes `image-1.png`; the jpeg-labelled PNG at index 1 is
        // written as `image-1.jpg`, and its sniffed rename must not clobber it.
        const result = {
          content: [
            { ...replacing, resource: { ...replacing.resource, uri: "file:///image-1.png" } },
            { type: "image", data: PNG_B64, mimeType: "image/jpeg" },
          ],
        } as unknown as CallToolResult;
        const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "c5" });

        const [resourcePointer, imagePointer] = pointers(out);
        expect(resourcePointer).toContain("resources/c5-image-1.png (8 bytes");
        expect(imagePointer).toContain("resources/c5-image-1-2.png (70 bytes, image/png");
        expect(await read("c5-image-1.png").then(String)).toBe("REPLACED");
        expect(new Uint8Array(await read("c5-image-1-2.png"))).toEqual(PNG_BYTES);
        expect((await fs.readdir(path.join(workspace, "resources"))).sort()).toEqual([
          "c5-image-1-2.png",
          "c5-image-1.png",
        ]);
      });
    });
  });
});
