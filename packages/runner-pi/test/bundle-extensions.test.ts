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
    await prepareBundleForPi(bundle, { workspaceDir: workspace });

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

  it("registers no runtime tools — they are MCP defs hosted elsewhere", async () => {
    // Runtime tools (output/log/note/pin) are no longer Pi extensions
    // built here: they are transport-neutral MCP defs
    // (`@appstrate/core/runtime-tool-defs`) served by the sidecar or
    // registered by the no-sidecar call site via `buildRuntimeToolExtensions`.
    // `prepareBundleForPi` is skills-only and returns nothing — even a
    // `runtimeTools` selection produces no side effect here.
    const root = makeBundlePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      { runtimeTools: ["output", "log"] },
    );
    const bundle = makeTestBundle(root);
    const result = await prepareBundleForPi(bundle, { workspaceDir: workspace });
    expect(result).toBeUndefined();
  });
});

describe("prepareBundleForPi — workspace contract", () => {
  it("is idempotent and preserves the materialised .pi/ subtree", async () => {
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

    // Calling twice against the same workspace overwrites files in place.
    await prepareBundleForPi(bundle, { workspaceDir: workspace });
    await prepareBundleForPi(bundle, { workspaceDir: workspace });

    const piSkillPath = path.join(workspace, ".pi", "skills", "@acme", "s", "SKILL.md");
    const piSkillExists = await fs
      .stat(piSkillPath)
      .then(() => true)
      .catch(() => false);
    expect(piSkillExists).toBe(true);
  });
});
