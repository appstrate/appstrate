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
          uri: "appstrate://provider-response/run_x/ULID",
          mimeType: "application/json",
        },
      ],
    } as unknown as CallToolResult;
    const out = await spillResourcesToWorkspace(result, { workspace, toolCallId: "tc5" });
    expect(out).toBe(result);
  });

  it("fetches a resource_link, spills it to a file with a mime-derived extension", async () => {
    const json = JSON.stringify({ user: "Pierre", id: 1045141849 });
    const uri = "appstrate://provider-response/run_x/06F5AZ8FKDQK7CFJVCCYE2Y858";
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
          uri: "appstrate://provider-response/run_x/Z",
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
});
