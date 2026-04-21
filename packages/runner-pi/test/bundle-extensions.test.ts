// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for prepareBundleForPi — materialisation of the `.pi/` layout
 * from a LoadedBundle and dynamic-loading of tool entrypoints.
 *
 * Strategy: build synthetic LoadedBundle objects in-memory, point the
 * helper at a fresh per-test tempdir, and assert FS side-effects +
 * returned factories via a captured registerTool call. Because Bun's
 * dynamic import() is path-based, each test writes out a real tool
 * entrypoint and imports it for real — no module mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { prepareBundleForPi } from "../src/bundle-extensions.ts";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bundleFromFiles(
  files: Record<string, string | Uint8Array>,
  manifest: Record<string, unknown>,
): LoadedBundle {
  const encoded: Record<string, Uint8Array> = {};
  encoded["manifest.json"] = encode(JSON.stringify(manifest));
  for (const [p, content] of Object.entries(files)) {
    encoded[p] = typeof content === "string" ? encode(content) : content;
  }
  return {
    manifest,
    prompt: "test prompt",
    files: encoded,
    compressedSize: 0,
    decompressedSize: Object.values(encoded).reduce((acc, b) => acc + b.byteLength, 0),
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "runner-pi-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("prepareBundleForPi — skills/ and providers/ install", () => {
  it("copies every skill file under .pi/skills/", async () => {
    const bundle = bundleFromFiles(
      {
        "skills/writing/SKILL.md": "# writing skill",
        "skills/writing/examples.md": "example",
        "skills/deeper/nested/file.md": "nested",
      },
      { name: "test-agent" },
    );
    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    await cleanup();

    expect(
      await fs.readFile(path.join(workspace, ".pi", "skills", "writing", "SKILL.md"), "utf8"),
    ).toBe("# writing skill");
    expect(
      await fs.readFile(path.join(workspace, ".pi", "skills", "writing", "examples.md"), "utf8"),
    ).toBe("example");
    expect(
      await fs.readFile(
        path.join(workspace, ".pi", "skills", "deeper", "nested", "file.md"),
        "utf8",
      ),
    ).toBe("nested");
  });

  it("copies providers/ the same way", async () => {
    const bundle = bundleFromFiles(
      {
        "providers/gmail/provider.json": '{"name":"gmail"}',
      },
      { name: "test-agent" },
    );
    await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(
      await fs.readFile(path.join(workspace, ".pi", "providers", "gmail", "provider.json"), "utf8"),
    ).toBe('{"name":"gmail"}');
  });

  it("creates .pi dir even when bundle has no skills/providers (noop)", async () => {
    const bundle = bundleFromFiles({}, { name: "test-agent" });
    const { extensionFactories, cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });
    expect(extensionFactories).toEqual([]);
    // Nothing was written under .pi/skills — the helper is lazy.
    await cleanup();
  });
});

describe("prepareBundleForPi — tool loading", () => {
  // A minimal ExtensionFactory source that registers a callable default
  // export. The helper dynamic-imports this file.
  const TOOL_SOURCE = `
export default function factory(pi) {
  pi._registeredViaThisFactory = true;
  return { name: "test-tool", version: "1.0.0" };
}
`;

  it("dynamic-imports the tool entrypoint and returns a factory", async () => {
    const bundle = bundleFromFiles(
      {
        "tools/my-tool/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "my-tool" },
        }),
        "tools/my-tool/index.ts": TOOL_SOURCE,
      },
      {
        name: "test-agent",
        dependencies: { tools: { "my-tool": "1.0.0" } },
      },
    );

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);

    // Exercise the factory against a captured pi object so we know the
    // real factory (not a stub) is returned.
    const pi = {} as unknown as Record<string, unknown>;
    const result = extensionFactories[0]!(
      pi as unknown as Parameters<(typeof extensionFactories)[number]>[0],
    );
    expect(pi._registeredViaThisFactory).toBe(true);
    expect((result as unknown as { name: string }).name).toBe("test-tool");
  });

  it("writes TOOL.md under .pi/tools/<toolId>/TOOL.md", async () => {
    const bundle = bundleFromFiles(
      {
        "tools/my-tool/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "my-tool" },
        }),
        "tools/my-tool/index.ts": TOOL_SOURCE,
        "tools/my-tool/TOOL.md": "# Usage",
      },
      {
        name: "test-agent",
        dependencies: { tools: { "my-tool": "1.0.0" } },
      },
    );

    await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(
      await fs.readFile(path.join(workspace, ".pi", "tools", "my-tool", "TOOL.md"), "utf8"),
    ).toBe("# Usage");
  });

  it("dedups tools by manifest.tool.name", async () => {
    // Two bundle entries map to the same resolved tool name.
    const bundle = bundleFromFiles(
      {
        "tools/alias-a/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "canonical" },
        }),
        "tools/alias-a/index.ts": TOOL_SOURCE,
        "tools/alias-b/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "canonical" },
        }),
        "tools/alias-b/index.ts": TOOL_SOURCE,
      },
      {
        name: "test-agent",
        dependencies: {
          tools: { "alias-a": "1.0.0", "alias-b": "1.0.0" },
        },
      },
    );

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);
  });

  it("applies extensionWrapper to every factory", async () => {
    const wrappedIds: string[] = [];
    const bundle = bundleFromFiles(
      {
        "tools/my-tool/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "my-tool" },
        }),
        "tools/my-tool/index.ts": TOOL_SOURCE,
      },
      {
        name: "test-agent",
        dependencies: { tools: { "my-tool": "1.0.0" } },
      },
    );

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
    const bundle = bundleFromFiles(
      {
        "tools/bad/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "bad" },
        }),
        "tools/bad/index.ts": `throw new Error("boom at module load");`,
        "tools/good/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "good" },
        }),
        "tools/good/index.ts": TOOL_SOURCE,
      },
      {
        name: "test-agent",
        dependencies: { tools: { bad: "1.0.0", good: "1.0.0" } },
      },
    );

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
    const bundle = bundleFromFiles(
      {
        "tools/oops/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "oops" },
        }),
        "tools/oops/index.ts": `export default { not: "a function" };`,
      },
      {
        name: "test-agent",
        dependencies: { tools: { oops: "1.0.0" } },
      },
    );

    const { extensionFactories } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
      onError: (msg) => errors.push(msg),
    });
    expect(extensionFactories).toHaveLength(0);
    expect(errors[0]).toContain("oops");
  });

  it("skips tool declared in dependencies but missing from files", async () => {
    const bundle = bundleFromFiles(
      {},
      {
        name: "test-agent",
        dependencies: { tools: { ghost: "1.0.0" } },
      },
    );
    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(0);
  });

  it("skips tool when its manifest.json is absent", async () => {
    const bundle = bundleFromFiles(
      {
        "tools/x/index.ts": TOOL_SOURCE, // no manifest
      },
      { name: "test-agent", dependencies: { tools: { x: "1.0.0" } } },
    );
    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(0);
  });

  it("skips tool when manifest has no entrypoint", async () => {
    const bundle = bundleFromFiles(
      {
        "tools/x/manifest.json": JSON.stringify({ tool: { name: "x" } }), // no entrypoint
      },
      { name: "test-agent", dependencies: { tools: { x: "1.0.0" } } },
    );
    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(0);
  });

  it("preserves multi-file tool layout (relative imports resolve)", async () => {
    const bundle = bundleFromFiles(
      {
        "tools/multi/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "multi" },
        }),
        "tools/multi/index.ts": `
import { suffix } from "./helper.ts";
export default function factory(pi) {
  pi._value = "hello" + suffix;
  return { name: "multi" };
}
`,
        "tools/multi/helper.ts": `export const suffix = " world";`,
      },
      {
        name: "test-agent",
        dependencies: { tools: { multi: "1.0.0" } },
      },
    );

    const { extensionFactories } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(extensionFactories).toHaveLength(1);
    const pi = {} as Record<string, unknown>;
    extensionFactories[0]!(pi as unknown as Parameters<(typeof extensionFactories)[number]>[0]);
    expect(pi._value).toBe("hello world");
  });
});

describe("prepareBundleForPi — cleanup", () => {
  it("removes .agent-tools/ but preserves .pi/", async () => {
    const bundle = bundleFromFiles(
      {
        "skills/s/SKILL.md": "# s",
        "tools/t/manifest.json": JSON.stringify({
          entrypoint: "index.ts",
          tool: { name: "t" },
        }),
        "tools/t/index.ts": "export default () => ({});",
      },
      {
        name: "test-agent",
        dependencies: { tools: { t: "1.0.0" } },
      },
    );

    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });

    // Pre-cleanup: both directories exist.
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

    // .pi/skills/ survives — it's part of the workspace contract.
    const piSkillExists = await fs
      .stat(path.join(workspace, ".pi", "skills", "s", "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    expect(piSkillExists).toBe(true);
  });

  it("cleanup is idempotent", async () => {
    const bundle = bundleFromFiles({}, { name: "test-agent" });
    const { cleanup } = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    await cleanup();
    await cleanup(); // should not throw
  });
});
