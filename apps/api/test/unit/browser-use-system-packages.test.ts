// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "../../../../scripts/system-packages");

async function readPackage(name: "leboncoin" | "vinted") {
  const root = join(PACKAGE_ROOT, `mcp-server-${name}-browser-1.0.0`);
  const [manifestRaw, source] = await Promise.all([
    readFile(join(root, "manifest.json"), "utf8"),
    readFile(join(root, "server/index.py"), "utf8"),
  ]);
  return {
    manifest: JSON.parse(manifestRaw) as {
      server: { type: string; entry_point: string };
      tools: Array<{ name: string }>;
      _meta: Record<string, Record<string, unknown>>;
    },
    source,
  };
}

describe("Browser Use system MCP packages", () => {
  it.each([
    ["leboncoin", ["acquire_session", "get_listing", "search_listings", "session_status"]],
    [
      "vinted",
      [
        "acquire_session",
        "browser_status",
        "get_item",
        "prepare_item_draft",
        "publish_item",
        "search_items",
      ],
    ],
  ] as const)("runs %s through the pinned first-party runtime", async (name, expectedTools) => {
    const { manifest, source } = await readPackage(name);
    expect(manifest.server).toMatchObject({ type: "python", entry_point: "server/index.py" });
    expect(manifest._meta["dev.appstrate/mcp-server"]?.runtime).toBe("browser-use");
    expect(manifest._meta["dev.appstrate/mcp-server"]?.capabilities).toBeDefined();
    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
    expect(source).toContain("from appstrate_browser_use import");
    expect(source).not.toContain("from browser_use import Agent");
    expect(source).not.toContain("BROWSER_USE_API_KEY");
  });

  it("keeps credential input on Browser Use's redacted sensitive-data path", async () => {
    for (const name of ["leboncoin", "vinted"] as const) {
      const { source } = await readPackage(name);
      expect(source).toContain('secret_name="login_email"');
      expect(source).toContain('secret_name="login_password"');
      expect(source).not.toMatch(/evaluate\([^)]*(?:email|password)/s);
    }
  });

  it("keeps Vinted publication behind a one-time token and explicit confirmation", async () => {
    const { source } = await readPackage("vinted");
    expect(source).toContain("secrets.compare_digest");
    expect(source).toContain('args.get("confirm_publish") is not True');
    expect(source).toContain("self.draft = None");
    expect(source).toContain("resolve_workspace_images");
  });
});
