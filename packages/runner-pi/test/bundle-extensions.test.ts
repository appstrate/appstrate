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

  it("injects no built-in runtime tools when the bundle has no skills/providers/runtimeTools", async () => {
    // Every runtime tool is opt-in (output included). With no `runtimeTools`
    // selection there is nothing to inject — a side-effect-only agent that
    // just does a task and finishes is valid.
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeTestBundle(root);
    const { extensionFactories, cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });
    expect(extensionFactories).toHaveLength(0);
    await cleanup();
  });

  it("does NOT register runtime tools — they are MCP defs hosted elsewhere", async () => {
    // Runtime tools (output/log/note/pin/report) are no longer Pi extensions
    // built here: they are transport-neutral MCP defs
    // (`@appstrate/core/runtime-tool-defs`) served by the sidecar or
    // registered by the no-sidecar call site via `buildRuntimeToolExtensions`.
    // `prepareBundleForPi` is skills-only, so even a `runtimeTools` selection
    // yields no factories.
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      { runtimeTools: ["output", "log"] },
    );
    const bundle = makeTestBundle(root);
    const { extensionFactories, cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });
    expect(extensionFactories).toHaveLength(0);
    await cleanup();
  });
});

describe("prepareBundleForPi — cleanup", () => {
  it("cleanup preserves the materialised .pi/ subtree (no-op teardown)", async () => {
    // The `tool` package type was removed — built-in runtime tools need no
    // scratch dir, so `cleanup` is a no-op retained for API stability. It
    // must NOT touch `.pi/`, which is part of the workspace contract.
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: {
          skills: { "@acme/s": "^1" },
        },
      },
    );
    const skillPkg = makeBundlePackage("@acme/s", "1.0.0", "skill", { "SKILL.md": "# s" });
    const bundle = makeTestBundle(root, [skillPkg]);

    const { cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });

    const piSkillPath = path.join(workspace, ".pi", "skills", "@acme", "s", "SKILL.md");
    const beforeExists = await fs
      .stat(piSkillPath)
      .then(() => true)
      .catch(() => false);
    expect(beforeExists).toBe(true);

    await cleanup();

    const piSkillExists = await fs
      .stat(piSkillPath)
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
