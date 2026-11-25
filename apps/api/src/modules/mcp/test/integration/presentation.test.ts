// SPDX-License-Identifier: Apache-2.0

/**
 * The presentation every tool result carries (`_meta["dev.appstrate/presentation"]`): stamped
 * once by `presentTools`, from the descriptor unless the tool knows more, never over what a handler
 * stamped itself.
 */

import { describe, it, expect } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { readToolPresentation, TOOL_PRESENTATION_META_KEY } from "@appstrate/core/mcp-presentation";
import { getCatalog } from "../../catalog.ts";
import { descriptorPresentation, presentTools, withPresentation } from "../../presentation.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";

// The catalog reads the platform app's operations.
await registerTestPlatformApp();

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

function tool(descriptor: Partial<Tool> & { name: string }, result: CallToolResult) {
  return {
    descriptor: { inputSchema: { type: "object" }, ...descriptor },
    handler: async () => result,
  } satisfies AppstrateToolDefinition;
}

async function call(definition: AppstrateToolDefinition, args: Record<string, unknown> = {}) {
  const [presented] = presentTools([definition]);
  const result = await presented!.handler(args, {} as never);
  return { result, presentation: readToolPresentation(result._meta) };
}

describe("descriptorPresentation", () => {
  it("reads the title and the read-only hint", () => {
    expect(
      descriptorPresentation({
        name: "list_files",
        inputSchema: { type: "object" },
        annotations: { title: "List files", readOnlyHint: true },
      }),
    ).toEqual({ title: "List files", read_only: true, destructive: false });
  });

  it("counts destructiveHint only when stated, never MCP's default", () => {
    const base = { name: "x", inputSchema: { type: "object" as const } };
    expect(descriptorPresentation(base)).toEqual({
      title: "x",
      read_only: false,
      destructive: false,
    });
    expect(
      descriptorPresentation({ ...base, annotations: { destructiveHint: true } }).destructive,
    ).toBe(true);
  });
});

describe("presentTools", () => {
  it("stamps the descriptor's presentation on a result nothing describes", async () => {
    const { result, presentation } = await call(
      tool({ name: "read", annotations: { title: "Read resource", readOnlyHint: true } }, text({})),
    );
    expect(presentation).toEqual({ title: "Read resource", read_only: true, destructive: false });
    // The model's channel is untouched.
    expect(result.content).toEqual(text({}).content);
  });

  it("keeps what a handler stamped itself", async () => {
    const own = { title: "Search", read_only: true, destructive: false, count: 3 };
    const { presentation } = await call(tool({ name: "search" }, withPresentation(text({}), own)));
    expect(presentation).toEqual(own);
  });

  it("names an operation by its OpenAPI summary, tag and method", async () => {
    const op = [...getCatalog().operations.values()].find(
      (candidate) => candidate.method === "DELETE" && candidate.tags.length > 0,
    )!;
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: op.operationId,
    });
    expect(presentation).toMatchObject({
      title: op.summary || op.operationId,
      tag: op.tags[0],
      method: "DELETE",
      read_only: false,
      destructive: true,
    });
  });

  it("marks a GET operation read-only and names the package its path targets", async () => {
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: "getAgentModel",
      path_params: { scope: "@acme", name: "triage" },
    });
    expect(presentation).toMatchObject({
      method: "GET",
      read_only: true,
      destructive: false,
      subject: { kind: "agent", id: "@acme/triage" },
    });
  });

  it("falls back to the descriptor for an unknown operation", async () => {
    const { presentation } = await call(
      tool({ name: "invoke_operation", annotations: { title: "Invoke API operation" } }, text({})),
      { operation_id: "noSuchOperation" },
    );
    expect(presentation?.title).toBe("Invoke API operation");
  });

  it("names the caller get_me answered for", async () => {
    const { presentation } = await call(
      tool(
        { name: "get_me", annotations: { title: "Get caller context", readOnlyHint: true } },
        { ...text({}), structuredContent: { user: { id: "usr_1", name: "Ada" } } },
      ),
    );
    expect(presentation?.subject).toEqual({ kind: "user", id: "usr_1", display_name: "Ada" });
  });

  it("writes under the documented key", async () => {
    const { result } = await call(tool({ name: "x" }, text({})));
    expect(result._meta?.[TOOL_PRESENTATION_META_KEY]).toBeDefined();
  });
});
