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

  it("injects only the mandatory `output` built-in when bundle has no skills/providers/runtimeTools", async () => {
    // No skill/provider deps means no `.pi/` materialisation, but the
    // mandatory `output` built-in runtime tool is always injected (the
    // former `@appstrate/output` tool package, now baked into the runner).
    const root = makeBundlePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeTestBundle(root);
    const { extensionFactories, cleanup } = await prepareBundleForPi(bundle, {
      workspaceDir: workspace,
    });
    expect(extensionFactories).toHaveLength(1);
    expect(typeof extensionFactories[0]).toBe("function");
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
