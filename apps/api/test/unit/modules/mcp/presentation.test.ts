// SPDX-License-Identifier: Apache-2.0

/** `presentTools`: the presentation a tool knows of its call, never over what its handler stamped. */

import { describe, it, expect } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import {
  readToolPresentation,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { getCatalog } from "../../../../src/modules/mcp/catalog.ts";
import { collectModuleOpenApi } from "../../../../../../scripts/lib/module-openapi.ts";
import { presentTools, withPresentation } from "../../../../src/modules/mcp/presentation.ts";
import { manifestIcons } from "../../../../src/modules/mcp/tool-icons.ts";
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

const subjectOf = (presentation: ToolPresentation | undefined) =>
  presentation && "subject" in presentation ? presentation.subject : undefined;

async function call(definition: AppstrateToolDefinition, args: Record<string, unknown> = {}) {
  const [presented] = presentTools([definition]);
  const result = await presented!.handler(args, {} as never);
  return { result, presentation: readToolPresentation(result._meta) };
}

describe("presentTools", () => {
  it("keeps what a handler stamped, and stamps nothing a tool knows nothing of", async () => {
    const own = { call: "search", count: 3, items: [] } satisfies ToolPresentation;
    const stamped = await call(tool({ name: "search" }, withPresentation(text({}), own)));
    expect(stamped.presentation).toEqual(own);
    const plain = await call(tool({ name: "read", annotations: { title: "Read" } }, text({})));
    expect(plain.result).toEqual(text({}));
  });

  it("names an operation by its tag and method", async () => {
    const op = [...getCatalog().operations.values()].find(
      (candidate) => candidate.method === "DELETE" && candidate.tags.length > 0,
    )!;
    const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: op.operationId,
    });
    expect(presentation).toMatchObject({ call: "operation", tag: op.tags[0], method: "DELETE" });
    const unknown = await call(tool({ name: "invoke_operation" }, text({})), {
      operation_id: "noSuchOperation",
    });
    expect(unknown.presentation).toBeUndefined();
  });

  it("names the package an operation's path aims at, from its arguments", async () => {
    const ops = [...getCatalog().operations.values()];
    const at = (path: RegExp | string) =>
      ops.find((op) =>
        typeof path === "string" ? op.pathTemplate === path : path.test(op.pathTemplate),
      )!.operationId;
    const acme = { scope: "acme", name: "triage" };
    const cases: [string, Record<string, string>, PresentationSubject | undefined][] = [
      [
        at(/^\/api\/agents\/\{scope\}\/\{name\}\/model$/),
        acme,
        { kind: "agent", id: "@acme/triage" },
      ],
      [
        at(/^\/api\/packages\/skills\/\{scope\}\/\{name\}$/),
        acme,
        { kind: "skill", id: "@acme/triage" },
      ],
      [
        at(/^\/api\/packages\/integrations\/\{scope\}\/\{name\}$/),
        acme,
        { kind: "integration", id: "@acme/triage" },
      ],
      // A run's or a schedule's operation names the agent it is under, whatever its tag.
      ["runAgent", { scope: "@acme", name: "triage" }, { kind: "agent", id: "@acme/triage" }],
      ["createSchedule", acme, { kind: "agent", id: "@acme/triage" }],
      // The parameter after the kind's segment, whatever its name.
      [
        at("/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}"),
        { agentPackageId: "@acme/triage", integrationPackageId: "@acme/gmail" },
        { kind: "integration", id: "@acme/gmail" },
      ],
      // The arguments leave the id out, or the path names no package.
      ["runAgent", { scope: "acme" }, undefined],
      [at("/api/runs/{id}"), { id: "run_1" }, undefined],
    ];
    for (const [operation_id, path_params, subject] of cases) {
      const { presentation } = await call(tool({ name: "invoke_operation" }, text({})), {
        operation_id,
        path_params,
      });
      expect(subjectOf(presentation)).toEqual(subject);
    }
  });

  it("answers a handler's throw as a failed call, presented like any other result", async () => {
    const throwing = (name: string) =>
      ({
        descriptor: { name, inputSchema: { type: "object" } },
        handler: async () => {
          throw new Error("database unreachable");
        },
      }) satisfies AppstrateToolDefinition;
    const invoked = await call(throwing("invoke_operation"), {
      operation_id: "runAgent",
      path_params: { scope: "acme", name: "triage" },
    });
    expect(invoked.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "database unreachable" }],
    });
    // What the call aimed at, although it failed.
    expect(subjectOf(invoked.presentation)).toEqual({ kind: "agent", id: "@acme/triage" });
  });

  it("names the caller get_me answered for", async () => {
    const { presentation } = await call(
      tool({ name: "get_me" }, text({ status: 200, body: { user: { id: "usr_1", name: "Ada" } } })),
    );
    expect(presentation?.call).toBe("caller");
    expect(subjectOf(presentation)).toEqual({ kind: "user", id: "usr_1", display_name: "Ada" });
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

describe("manifestIcons", () => {
  it("keeps an image URL as it is, with the type a data URI declares", () => {
    expect(manifestIcons("https://example.test/a.svg")).toEqual([
      { src: "https://example.test/a.svg" },
    ]);
    expect(manifestIcons("data:image/png;base64,AAAA")).toEqual([
      { src: "data:image/png;base64,AAAA", mimeType: "image/png" },
    ]);
  });

  it("points an Iconify id, Lucide's included, at its SVG file", () => {
    expect(manifestIcons("logos:slack-icon")).toEqual([
      { src: "https://api.iconify.design/logos/slack-icon.svg", mimeType: "image/svg+xml" },
    ]);
    expect(manifestIcons("lucide:bot")?.[0]?.src).toBe("https://api.iconify.design/lucide/bot.svg");
  });

  it("draws an emoji as an inline SVG, and a value nothing can draw as none", () => {
    const [emoji] = manifestIcons("emoji:🚜") ?? [];
    expect(emoji?.mimeType).toBe("image/svg+xml");
    expect(decodeURIComponent(emoji?.src ?? "")).toContain("🚜");
    expect(manifestIcons("icon.png")).toBeUndefined();
    expect(manifestIcons(undefined)).toBeUndefined();
  });
});
