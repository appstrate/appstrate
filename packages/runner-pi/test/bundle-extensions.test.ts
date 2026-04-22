// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for prepareBundleForPi — materialisation of the `.pi/` layout
 * from a {@link Bundle} and dynamic-loading of tool entrypoints.
 *
 * Strategy: build synthetic spec bundles in-memory, point the helper at
 * a fresh per-test tempdir, and assert FS side-effects + returned
 * factories via a captured registerTool call. Because Bun's dynamic
 * import() is path-based, each test writes out a real tool entrypoint
 * and imports it for real — no module mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { prepareBundleForPi } from "../src/bundle-extensions.ts";
import { makeBundlePackage, makeTestBundle } from "./helpers.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "runner-pi-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("prepareBundleForPi — skills/ and providers/ install", () => {
  it("copies every skill file under .pi/skills/<packageId>/", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { skills: { "@acme/writing": "^1" } },
      },
    );
    const skillPkg = makeBundlePackage("@acme/writing", "1.0.0", "skill", {
      "SKILL.md": "# writing skill",
      "examples.md": "example",
      "deeper/nested/file.md": "nested",
    });
    const bundle = makeTestBundle(root, [skillPkg]);
    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    await cleanup();

    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "skills", "@acme", "writing", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# writing skill");
    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "skills", "@acme", "writing", "examples.md"),
        "utf8",
      ),
    ).toBe("example");
    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "skills", "@acme", "writing", "deeper", "nested", "file.md"),
        "utf8",
      ),
    ).toBe("nested");
  });

  it("copies providers/ the same way", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { providers: { "@acme/gmail": "^1" } },
      },
    );
    const providerPkg = makeBundlePackage("@acme/gmail", "1.0.0", "provider", {
      "provider.json": '{"name":"gmail"}',
    });
    const bundle = makeTestBundle(root, [providerPkg]);
    await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "providers", "@acme", "gmail", "provider.json"),
        "utf8",
      ),
    ).toBe('{"name":"gmail"}');
  });

  it("creates .pi dir even when bundle has no skills/providers (noop)", async () => {
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeTestBundle(root);
    const { extensionFactories, cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });
    expect(extensionFactories).toEqual([]);
    await cleanup();
  });
});

describe("prepareBundleForPi — tool loading", () => {
  const TOOL_SOURCE = `
export default function factory(pi) {
  pi._registeredViaThisFactory = true;
  return { name: "test-tool", version: "1.0.0" };
}
`;

  it("dynamic-imports the tool entrypoint and returns a factory", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/my-tool": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/my-tool",
      "1.0.0",
      "tool",
      {
        "index.ts": TOOL_SOURCE,
      },
      { entrypoint: "index.ts", tool: { name: "my-tool" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);

    const pi = {} as unknown as Record<string, unknown>;
    const result = extensionFactories[0]!(
      pi as unknown as Parameters<(typeof extensionFactories)[number]>[0],
    );
    expect(pi._registeredViaThisFactory).toBe(true);
    expect((result as unknown as { name: string }).name).toBe("test-tool");
  });

  it("writes TOOL.md under .pi/tools/<packageId>/TOOL.md", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/my-tool": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/my-tool",
      "1.0.0",
      "tool",
      {
        "index.ts": TOOL_SOURCE,
        "TOOL.md": "# Usage",
      },
      { entrypoint: "index.ts", tool: { name: "my-tool" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "tools", "@acme", "my-tool", "TOOL.md"),
        "utf8",
      ),
    ).toBe("# Usage");
  });

  it("dedups tools by manifest.tool.name", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/alias-a": "^1", "@acme/alias-b": "^1" } },
      },
    );
    const toolA = makeBundlePackage(
      "@acme/alias-a",
      "1.0.0",
      "tool",
      { "index.ts": TOOL_SOURCE },
      { entrypoint: "index.ts", tool: { name: "canonical" } },
    );
    const toolB = makeBundlePackage(
      "@acme/alias-b",
      "1.0.0",
      "tool",
      { "index.ts": TOOL_SOURCE },
      { entrypoint: "index.ts", tool: { name: "canonical" } },
    );
    const bundle = makeTestBundle(root, [toolA, toolB]);

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);
  });

  it("applies extensionWrapper to every factory", async () => {
    const wrappedIds: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/my-tool": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/my-tool",
      "1.0.0",
      "tool",
      { "index.ts": TOOL_SOURCE },
      { entrypoint: "index.ts", tool: { name: "my-tool" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      extensionWrapper: (factory, id) => {
        wrappedIds.push(id);
        return factory;
      },
    });
    expect(wrappedIds).toEqual(["my-tool"]);
    expect(extensionFactories).toHaveLength(1);
  });

  it("reports onError and continues when a tool entrypoint throws on import", async () => {
    const errors: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/bad": "^1", "@acme/good": "^1" } },
      },
    );
    const bad = makeBundlePackage(
      "@acme/bad",
      "1.0.0",
      "tool",
      { "index.ts": `throw new Error("boom at module load");` },
      { entrypoint: "index.ts", tool: { name: "bad" } },
    );
    const good = makeBundlePackage(
      "@acme/good",
      "1.0.0",
      "tool",
      { "index.ts": TOOL_SOURCE },
      { entrypoint: "index.ts", tool: { name: "good" } },
    );
    const bundle = makeTestBundle(root, [bad, good]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad");
  });

  it("reports onError when default export is not a function", async () => {
    const errors: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/oops": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/oops",
      "1.0.0",
      "tool",
      { "index.ts": `export default { not: "a function" };` },
      { entrypoint: "index.ts", tool: { name: "oops" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(0);
    expect(errors[0]).toContain("oops");
  });

  it("skips tool declared in dependencies but missing from the bundle", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/ghost": "^1" } },
      },
    );
    const bundle = makeTestBundle(root);
    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(0);
  });

  it("skips tool when manifest has no entrypoint", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/x": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/x",
      "1.0.0",
      "tool",
      {},
      { tool: { name: "x" } }, // no entrypoint
    );
    const bundle = makeTestBundle(root, [toolPkg]);
    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(0);
  });

  it("preserves multi-file tool layout (relative imports resolve)", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/multi": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/multi",
      "1.0.0",
      "tool",
      {
        "index.ts": `
import { suffix } from "./helper.ts";
export default function factory(pi) {
  pi._value = "hello" + suffix;
  return { name: "multi" };
}
`,
        "helper.ts": `export const suffix = " world";`,
      },
      { entrypoint: "index.ts", tool: { name: "multi" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);
    const pi = {} as Record<string, unknown>;
    extensionFactories[0]!(pi as unknown as Parameters<(typeof extensionFactories)[number]>[0]);
    expect(pi._value).toBe("hello world");
  });
});

describe("prepareBundleForPi — cleanup", () => {
  it("removes .agent-tools/ but preserves .pi/", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: {
          skills: { "@acme/s": "^1" },
          tools: { "@acme/t": "^1" },
        },
      },
    );
    const skillPkg = makeBundlePackage("@acme/s", "1.0.0", "skill", { "SKILL.md": "# s" });
    const toolPkg = makeBundlePackage(
      "@acme/t",
      "1.0.0",
      "tool",
      { "index.ts": "export default () => ({});" },
      { entrypoint: "index.ts", tool: { name: "t" } },
    );
    const bundle = makeTestBundle(root, [skillPkg, toolPkg]);

    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });

    const scratchExists = await fs
      .stat(path.join(workspace, ".agent-tools"))
      .then(() => true)
      .catch(() => false);
    expect(scratchExists).toBe(true);

    await cleanup();

    const scratchGone = await fs
      .stat(path.join(workspace, ".agent-tools"))
      .then(() => true)
      .catch(() => false);
    expect(scratchGone).toBe(false);

    const piSkillExists = await fs
      .stat(path.join(workspace, ".pi", "skills", "@acme", "s", "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    expect(piSkillExists).toBe(true);
  });

  it("cleanup is idempotent", async () => {
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeTestBundle(root);
    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    await cleanup();
    await cleanup();
  });
});
