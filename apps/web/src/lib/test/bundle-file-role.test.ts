// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { bundleFileRole } from "../bundle-file-role";

describe("bundleFileRole", () => {
  test("names the manifest and each type's main file", () => {
    expect(bundleFileRole("skill", "manifest.json", {})).toBe("manifest");
    expect(bundleFileRole("agent", "prompt.md", {})).toBe("main");
    expect(bundleFileRole("skill", "SKILL.md", {})).toBe("main");
    expect(bundleFileRole("integration", "INTEGRATION.md", {})).toBe("documentation");
  });

  test("finds a local server's entry point in its manifest", () => {
    const manifest = { server: { type: "node", entry_point: "src/server.ts" } };
    expect(bundleFileRole("mcp-server", "src/server.ts", manifest)).toBe("entry-point");
    expect(bundleFileRole("mcp-server", "src/util.ts", manifest)).toBe("other");
  });

  test("reads the Agent Skills folders", () => {
    expect(bundleFileRole("skill", "references/fiscal-year.md", {})).toBe("reference");
    expect(bundleFileRole("skill", "scripts/extract-pdf.py", {})).toBe("script");
    expect(bundleFileRole("skill", "assets/logo.png", {})).toBe("asset");
    // A main file's name means nothing in another type's bundle.
    expect(bundleFileRole("skill", "prompt.md", {})).toBe("other");
  });
});
