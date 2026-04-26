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

describe("prepareBundleForPi — skills/ install", () => {
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

describe("prepareBundleForPi — provider → synthesised skill", () => {
  it("writes a synthesised SKILL.md at .pi/skills/provider-<scope>-<name>/", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { providers: { "@acme/gmail": "^1" } },
      },
    );
    const providerPkg = makeBundlePackage(
      "@acme/gmail",
      "1.0.0",
      "provider",
      { "PROVIDER.md": "# Gmail API\n\nBase URL: https://gmail.googleapis.com/" },
      {
        name: "Gmail",
        description: "Send and read mail",
        definition: {
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      },
    );
    const bundle = makeTestBundle(root, [providerPkg]);
    await prepareBundleForPi(bundle, { workspaceDir: workspace });

    const skillContents = await fs.readFile(
      path.join(workspace, ".pi", "skills", "provider-acme-gmail", "SKILL.md"),
      "utf8",
    );
    expect(skillContents).toContain("name: provider-acme-gmail");
    expect(skillContents).toContain("Gmail API.");
    expect(skillContents).toContain("READ this skill before any provider_call");
    expect(skillContents).toContain("## Provider metadata");
    expect(skillContents).toContain("- **providerId**: `@acme/gmail`");
    expect(skillContents).toContain("# Gmail API");

    const legacyDir = await fs
      .stat(path.join(workspace, ".pi", "providers"))
      .then(() => true)
      .catch(() => false);
    expect(legacyDir).toBe(false);
  });

  it("synthesises a usable skill even when the provider has no PROVIDER.md", async () => {
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { providers: { "@acme/notion": "^1" } },
      },
    );
    const providerPkg = makeBundlePackage(
      "@acme/notion",
      "1.0.0",
      "provider",
      {},
      {
        name: "Notion",
        definition: {
          authMode: "oauth2",
          docsUrl: "https://developers.notion.com/reference",
        },
      },
    );
    const bundle = makeTestBundle(root, [providerPkg]);
    await prepareBundleForPi(bundle, { workspaceDir: workspace });

    const skillContents = await fs.readFile(
      path.join(workspace, ".pi", "skills", "provider-acme-notion", "SKILL.md"),
      "utf8",
    );
    expect(skillContents).toContain("name: provider-acme-notion");
    expect(skillContents).toContain("No bundled PROVIDER.md");
    expect(skillContents).toContain("https://developers.notion.com/reference");
  });
});

describe("prepareBundleForPi — tool loading", () => {
  const TOOL_COMPILED = `
export default function factory(pi) {
  pi._registeredViaThisFactory = true;
  return { name: "test-tool", version: "1.0.0" };
}
`;

  it("dynamic-imports the entrypoint and returns a factory", async () => {
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
        "index.ts": "// source kept for authoring only — never loaded at runtime",
        "tool.js": TOOL_COMPILED,
      },
      { entrypoint: "tool.js", tool: { name: "my-tool" } },
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

  it("materialises only the entrypoint (not other files in the archive)", async () => {
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
        "index.ts":
          "// archive may keep sources for attribution — must NOT land on disk at load time",
        "tool.js": TOOL_COMPILED,
      },
      { entrypoint: "tool.js", tool: { name: "my-tool" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { toolsScratchDir } = await prepareBundleForPi(bundle, { workspaceDir: workspace });

    const entrypointExists = await fs
      .stat(path.join(toolsScratchDir, "@acme", "my-tool", "tool.js"))
      .then(() => true)
      .catch(() => false);
    expect(entrypointExists).toBe(true);

    const sourceExists = await fs
      .stat(path.join(toolsScratchDir, "@acme", "my-tool", "index.ts"))
      .then(() => true)
      .catch(() => false);
    expect(sourceExists).toBe(false);
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
        "tool.js": TOOL_COMPILED,
        "TOOL.md": "# Usage",
      },
      { entrypoint: "tool.js", tool: { name: "my-tool" } },
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
      { "tool.js": TOOL_COMPILED },
      { entrypoint: "tool.js", tool: { name: "canonical" } },
    );
    const toolB = makeBundlePackage(
      "@acme/alias-b",
      "1.0.0",
      "tool",
      { "tool.js": TOOL_COMPILED },
      { entrypoint: "tool.js", tool: { name: "canonical" } },
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
      { "tool.js": TOOL_COMPILED },
      { entrypoint: "tool.js", tool: { name: "my-tool" } },
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

  it("reports onError and continues when a tool artifact throws on import", async () => {
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
      { "tool.js": `throw new Error("boom at module load");` },
      { entrypoint: "tool.js", tool: { name: "bad" } },
    );
    const good = makeBundlePackage(
      "@acme/good",
      "1.0.0",
      "tool",
      { "tool.js": TOOL_COMPILED },
      { entrypoint: "tool.js", tool: { name: "good" } },
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
      { "tool.js": `export default { not: "a function" };` },
      { entrypoint: "tool.js", tool: { name: "oops" } },
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

  it("rejects tool without manifest.entrypoint", async () => {
    const errors: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/legacy": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/legacy",
      "1.0.0",
      "tool",
      { "tool.js": TOOL_COMPILED },
      // no entrypoint declared at all
      { tool: { name: "legacy" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(0);
    expect(errors[0]).toMatch(/manifest\.entrypoint/);
  });

  it("rejects tool whose manifest.entrypoint points at a missing file", async () => {
    const errors: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/missing": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/missing",
      "1.0.0",
      "tool",
      {},
      { entrypoint: "tool.js", tool: { name: "missing" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(0);
    expect(errors[0]).toMatch(/no such file/);
  });

  it("rejects tool with path-traversal manifest.entrypoint", async () => {
    const errors: string[] = [];
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { tools: { "@acme/trav": "^1" } },
      },
    );
    const toolPkg = makeBundlePackage(
      "@acme/trav",
      "1.0.0",
      "tool",
      { "tool.js": TOOL_COMPILED },
      { entrypoint: "../escape.js", tool: { name: "trav" } },
    );
    const bundle = makeTestBundle(root, [toolPkg]);

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(0);
    expect(errors[0]).toMatch(/unsafe|traversal/i);
  });
});

describe("prepareBundleForPi — cleanup", () => {
  it("removes the tool scratch dir but preserves .pi/", async () => {
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
      { "tool.js": "export default () => ({});" },
      { entrypoint: "tool.js", tool: { name: "t" } },
    );
    const bundle = makeTestBundle(root, [skillPkg, toolPkg]);

    const { cleanup, toolsScratchDir } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });

    const scratchExists = await fs
      .stat(toolsScratchDir)
      .then(() => true)
      .catch(() => false);
    expect(scratchExists).toBe(true);

    await cleanup();

    const scratchGone = await fs
      .stat(toolsScratchDir)
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
