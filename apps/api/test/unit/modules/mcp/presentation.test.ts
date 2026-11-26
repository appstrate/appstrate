// SPDX-License-Identifier: Apache-2.0

/**
 * The presentation every tool result carries (`_meta["dev.appstrate/presentation"]`): stamped
 * once by `presentTools`, from the descriptor unless the tool knows more, never over what a handler
 * stamped itself.
 */

import { describe, it, expect } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import {
  isLookupTool,
  readToolPresentation,
  TOOL_LOOKUP_META_KEY,
} from "@appstrate/core/mcp-presentation";
import { getCatalog } from "../../../../src/modules/mcp/catalog.ts";
import { collectModuleOpenApi } from "../../../../../../scripts/lib/module-openapi.ts";
import { presentTools, withPresentation } from "../../../../src/modules/mcp/presentation.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";

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

describe("presentTools", () => {
  it("names a call nothing describes as MCP names its tool: title, then annotations.title, then name", async () => {
    const titled = async (descriptor: Partial<Tool>) =>
      (await call(tool({ name: "list_files", ...descriptor }, text({})))).presentation;
    expect(await titled({})).toEqual({ title: "list_files" });
    expect(await titled({ annotations: { title: "List" } })).toEqual({ title: "List" });
    expect(await titled({ title: "List files", annotations: { title: "List" } })).toEqual({
      title: "List files",
    });
  });

  it("stamps the descriptor's presentation on a result nothing describes", async () => {
    const { result, presentation } = await call(
      tool({ name: "read", annotations: { title: "Read resource", readOnlyHint: true } }, text({})),
    );
    expect(presentation).toEqual({ title: "Read resource" });
    // The model's channel is untouched.
    expect(result.content).toEqual(text({}).content);
  });

  it("keeps what a handler stamped itself", async () => {
    const own = { title: "Search", count: 3 };
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
    });
  });

  it("names the agent, skill or integration an operation's path targets", async () => {
    const ops = [...getCatalog().operations.values()];
    const byPath = (pattern: RegExp) => ops.find((op) => pattern.test(op.pathTemplate))!;
    const cases = [
      [byPath(/^\/api\/agents\/\{scope\}\/\{name\}\/model$/), "agent"],
      [byPath(/^\/api\/packages\/skills\/\{scope\}\/\{name\}$/), "skill"],
      [byPath(/^\/api\/packages\/integrations\/\{scope\}\/\{name\}$/), "integration"],
    ] as const;
    for (const [op, kind] of cases) {
      const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
        operation_id: op.operationId,
        path_params: { scope: "acme", name: "triage" },
      });
      expect(presentation?.subject).toEqual({ kind, id: "@acme/triage" });
    }
  });

  it("names the agent a run's or a schedule's operation is under, whatever its tag", async () => {
    const cases = [
      ["runAgent", "Runs"],
      ["createSchedule", "Schedules"],
    ] as const;
    for (const [operationId, tag] of cases) {
      const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
        operation_id: operationId,
        path_params: { scope: "@acme", name: "triage" },
      });
      expect(presentation).toMatchObject({ tag, subject: { kind: "agent", id: "@acme/triage" } });
    }
  });

  it("takes the id from the parameter after the kind's segment, whatever its name", async () => {
    const op = [...getCatalog().operations.values()].find(
      (candidate) =>
        candidate.pathTemplate ===
        "/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}",
    )!;
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: op.operationId,
      path_params: { agentPackageId: "@acme/triage", integrationPackageId: "@acme/gmail" },
    });
    expect(presentation?.subject).toEqual({ kind: "integration", id: "@acme/gmail" });
  });

  it("names no subject when the arguments leave the package's id out", async () => {
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: "runAgent",
      path_params: { scope: "acme" },
    });
    expect(presentation?.subject).toBeUndefined();
  });

  it("names no subject for a path that targets no package", async () => {
    const op = [...getCatalog().operations.values()].find(
      (candidate) => candidate.pathTemplate === "/api/runs/{id}",
    )!;
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: op.operationId,
      path_params: { id: "run_1" },
    });
    expect(presentation?.subject).toBeUndefined();
  });

  it("falls back to the descriptor for an unknown operation", async () => {
    const { presentation } = await call(
      tool({ name: "invoke_operation", annotations: { title: "Invoke API operation" } }, text({})),
      { operation_id: "noSuchOperation" },
    );
    expect(presentation?.title).toBe("Invoke API operation");
  });

  it("answers a handler's throw as a failed call, presented like any other result", async () => {
    const throwing = (name: string, title: string) =>
      ({
        descriptor: { name, annotations: { title }, inputSchema: { type: "object" } },
        handler: async () => {
          throw new Error("database unreachable");
        },
      }) satisfies AppstrateToolDefinition;
    const op = [...getCatalog().operations.values()].find(
      (candidate) => candidate.pathTemplate === "/api/agents/{scope}/{name}/model",
    )!;
    const invoked = await call(throwing("invoke_operation", "Invoke API operation"), {
      operation_id: op.operationId,
      path_params: { scope: "acme", name: "triage" },
    });
    expect(invoked.result.isError).toBe(true);
    expect(invoked.result.content).toEqual([{ type: "text", text: "database unreachable" }]);
    // What the call aimed at, although it failed.
    expect(invoked.presentation).toMatchObject({
      title: op.summary || op.operationId,
      subject: { kind: "agent", id: "@acme/triage" },
    });
    const read = await call(throwing("read", "Read resource"));
    expect(read.result.isError).toBe(true);
    expect(read.presentation).toEqual({ title: "Read resource" });
  });

  it("names the caller get_me answered for", async () => {
    const { presentation } = await call(
      tool(
        { name: "get_me", annotations: { title: "Get caller context", readOnlyHint: true } },
        text({ status: 200, body: { user: { id: "usr_1", name: "Ada" } } }),
      ),
    );
    expect(presentation?.subject).toEqual({ kind: "user", id: "usr_1", display_name: "Ada" });
  });
});

describe("tool icons", () => {
  const [presented] = presentTools([tool({ name: "search" }, text({}))]);
  const icons = presented!.descriptor.icons ?? [];

  it("gives a platform tool one inline SVG per theme", () => {
    expect(icons.map((i) => i.theme)).toEqual(["light", "dark"]);
    for (const icon of icons) {
      expect(icon.mimeType).toBe("image/svg+xml");
      expect(icon.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(atob(icon.src.slice("data:image/svg+xml;base64,".length))).toContain("<svg");
    }
  });

  it("leaves a tool it draws no icon for as it is", () => {
    const [unknown] = presentTools([tool({ name: "x" }, text({}))]);
    expect(unknown!.descriptor.icons).toBeUndefined();
  });
});

describe("isLookupTool", () => {
  it("reads readOnlyHint or the lookup stamp, nothing else", () => {
    expect(isLookupTool({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(isLookupTool({ _meta: { [TOOL_LOOKUP_META_KEY]: true } })).toBe(true);
    expect(isLookupTool({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(isLookupTool({})).toBe(false);
  });
});

/** The first tag of every operation in `paths` (an OpenAPI Paths Object). */
function firstTags(paths: Record<string, unknown>): string[] {
  return Object.values(paths).flatMap((item) =>
    Object.values(item as Record<string, { tags?: string[] }>).flatMap(
      (op) => op?.tags?.slice(0, 1) ?? [],
    ),
  );
}

const moduleTags = firstTags((await collectModuleOpenApi()).paths);

describe("operation tags ↔ chat locales", () => {
  // A card shows an operation's first tag translated (`tool.tag.<tag>`, the chat namespace). The
  // catalog serves the modules this tier loads; a module it skips (one needing PostgreSQL) still
  // ships, so a tag of any in-tree module is not gone.
  const tags = new Set([...getCatalog().operations.values()].flatMap((op) => op.tags.slice(0, 1)));
  const inTree = new Set([...tags, ...moduleTags]);
  for (const lang of ["fr", "en"]) {
    it(`gives every tag a sentence in ${lang}, and no tag that is gone`, async () => {
      const locale = (await Bun.file(
        new URL(`../../../../../web/src/locales/${lang}/chat.json`, import.meta.url),
      ).json()) as Record<string, string>;
      const keyed = Object.keys(locale)
        .filter((key) => key.startsWith("tool.tag."))
        .map((key) => key.slice("tool.tag.".length));
      expect([...tags].filter((tag) => !keyed.includes(tag)).sort()).toEqual([]);
      expect(keyed.filter((tag) => !inTree.has(tag)).sort()).toEqual([]);
    });
  }
});
