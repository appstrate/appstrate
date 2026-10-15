// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for prepareBundleForPi — materialisation of skill and integration
 * members into the `.pi/` layout from a {@link Bundle}.
 *
 * Strategy: build synthetic spec bundles in-memory, point the helper at
 * a fresh per-test tempdir, and assert FS side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { bundleMemberDir, prepareBundleForPi } from "../src/bundle-extensions.ts";
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
    // registered by the CLI via `buildRuntimeToolExtensions`.
    // `prepareBundleForPi` only writes members and returns nothing — even a
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

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

/** `makeBundlePackage` types skills/agents; the manifest override makes it an integration. */
function makeIntegration(name: `@${string}/${string}`, files: Record<string, string>) {
  return makeBundlePackage(name, "1.0.0", "skill", files, { type: "integration" });
}

describe("prepareBundleForPi — integrations/ install", () => {
  it("copies every integration file under .pi/integrations/<packageId>/, never .pi/skills", async () => {
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent");
    const integration = makeIntegration("@acme/gmail", {
      "INTEGRATION.md": "# gmail",
      "docs/labels.md": "labels",
      RECORD: "record",
    });
    await prepareBundleForPi(makeTestBundle(root, [integration]), { workspaceDir: workspace });

    const dir = path.join(workspace, ".pi", "integrations", "@acme", "gmail");
    expect(await fs.readFile(path.join(dir, "INTEGRATION.md"), "utf8")).toBe("# gmail");
    expect(await fs.readFile(path.join(dir, "docs", "labels.md"), "utf8")).toBe("labels");
    expect(JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")).type).toBe(
      "integration",
    );
    expect(await exists(path.join(dir, "RECORD"))).toBe(false);
    expect(await exists(path.join(workspace, ".pi", "skills"))).toBe(false);
  });

  it("materialises the manifest of an integration without INTEGRATION.md", async () => {
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent");
    const integration = makeIntegration("@acme/bare", {});
    await prepareBundleForPi(makeTestBundle(root, [integration]), { workspaceDir: workspace });

    const dir = path.join(workspace, ".pi", "integrations", "@acme", "bare");
    expect(await exists(path.join(dir, "manifest.json"))).toBe(true);
    expect(await exists(path.join(dir, "INTEGRATION.md"))).toBe(false);
  });

  it("keeps skills and integrations in their own trees in a mixed bundle", async () => {
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent");
    const skill = makeBundlePackage("@acme/writing", "1.0.0", "skill", { "SKILL.md": "# w" });
    const integration = makeIntegration("@acme/gmail", { "INTEGRATION.md": "# g" });
    await prepareBundleForPi(makeTestBundle(root, [skill, integration]), {
      workspaceDir: workspace,
    });

    expect(
      await exists(path.join(workspace, ".pi", "skills", "@acme", "writing", "SKILL.md")),
    ).toBe(true);
    expect(await exists(path.join(workspace, ".pi", "skills", "@acme", "gmail"))).toBe(false);
    expect(
      await exists(path.join(workspace, ".pi", "integrations", "@acme", "gmail", "INTEGRATION.md")),
    ).toBe(true);
    expect(await exists(path.join(workspace, ".pi", "integrations", "@acme", "writing"))).toBe(
      false,
    );
  });
});

describe("bundleMemberDir", () => {
  it("maps skill and integration members, and nothing else", () => {
    const skill = makeBundlePackage("@acme/s", "1.0.0", "skill");
    const integration = makeIntegration("@acme/i", {});
    const agent = makeBundlePackage("@acme/a", "1.0.0", "agent");
    const inherited = makeBundlePackage("@acme/c", "1.0.0", "skill", {}, { type: "constructor" });

    expect(bundleMemberDir("/ws", skill.identity, skill)).toBe(
      path.join("/ws", ".pi", "skills", "@acme", "s"),
    );
    expect(bundleMemberDir("/ws", integration.identity, integration)).toBe(
      path.join("/ws", ".pi", "integrations", "@acme", "i"),
    );
    expect(bundleMemberDir("/ws", agent.identity, agent)).toBeNull();
    expect(bundleMemberDir("/ws", inherited.identity, inherited)).toBeNull();
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
