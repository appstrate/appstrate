// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Branch coverage for the two entry-point discovery helpers exported by
 * the integration bundler's npm / pypi vendoring resolvers:
 *
 *   - `pickNpmEntryPoint(pkg)` — pure; resolves the node entry from a
 *     `package.json#bin` / `#main` shape. No I/O.
 *   - `pickPypiEntryPoint(targetDir, identifier)` — reads a freshly-installed
 *     target tree's `*.dist-info/entry_points.txt`. Hermetic via real temp
 *     dirs (no network, no installer).
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pickNpmEntryPoint, BundlerError } from "../src/integration-bundle/npm-vendor.ts";
import type { NpmRegistryVersion } from "../src/integration-bundle/npm-vendor.ts";
import { pickPypiEntryPoint } from "../src/integration-bundle/pypi-vendor.ts";

describe("pickNpmEntryPoint", () => {
  // Each row exercises one precedence rung of the resolver:
  //   1. string `bin`
  //   2. object `bin` keyed by the package name
  //   3. object `bin`, no name match → first value
  //   4. no `bin`, fall back to `main`
  //   5. no `bin`, no `main` → literal `index.js`
  const cases: Array<{ name: string; pkg: NpmRegistryVersion; expected: string }> = [
    {
      name: "string bin → used directly",
      pkg: { name: "@scope/server", version: "1.0.0", bin: "./cli.js" },
      expected: "./cli.js",
    },
    {
      name: "object bin keyed by package name → that entry wins",
      pkg: {
        name: "@scope/server",
        version: "1.0.0",
        bin: { other: "./other.js", "@scope/server": "./named.js" },
      },
      expected: "./named.js",
    },
    {
      name: "object bin without a name match → first object value",
      pkg: {
        name: "@scope/server",
        version: "1.0.0",
        bin: { firstcmd: "./first.js", secondcmd: "./second.js" },
      },
      expected: "./first.js",
    },
    {
      name: "no bin, main present → main",
      pkg: { name: "@scope/server", version: "1.0.0", main: "./dist/main.js" },
      expected: "./dist/main.js",
    },
    {
      name: "no bin, no main → index.js fallback",
      pkg: { name: "@scope/server", version: "1.0.0" },
      expected: "index.js",
    },
  ];

  for (const { name, pkg, expected } of cases) {
    it(name, () => {
      expect(pickNpmEntryPoint(pkg)).toBe(expected);
    });
  }

  it("empty object bin falls through to main", () => {
    // `Object.values({})[0]` is undefined → neither named nor first match, so
    // the resolver drops to the `main` rung.
    const pkg: NpmRegistryVersion = {
      name: "@scope/server",
      version: "1.0.0",
      bin: {},
      main: "./entry.js",
    };
    expect(pickNpmEntryPoint(pkg)).toBe("./entry.js");
  });
});

describe("pickPypiEntryPoint", () => {
  let workDir: string;

  /** Materialise a `<name>.dist-info/entry_points.txt` with the given content. */
  async function writeEntryPoints(distInfoName: string, content: string): Promise<void> {
    const distInfo = join(workDir, distInfoName);
    await mkdir(distInfo, { recursive: true });
    await writeFile(join(distInfo, "entry_points.txt"), content, "utf8");
  }

  it("returns the script name from a [console_scripts] section", async () => {
    workDir = await mkdtemp(join(tmpdir(), "afps-pypi-ep-"));
    try {
      await writeEntryPoints(
        "mcp_server-1.2.0.dist-info",
        "[console_scripts]\nmcp-server = mcp_server.cli:main\n",
      );
      expect(await pickPypiEntryPoint(workDir, "mcp-server")).toBe("mcp-server");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("skips non-console_scripts sections and comments/blank lines", async () => {
    workDir = await mkdtemp(join(tmpdir(), "afps-pypi-ep-"));
    try {
      await writeEntryPoints(
        "mcp_server-1.2.0.dist-info",
        [
          "# a comment",
          "",
          "[gui_scripts]",
          "not-this = mcp_server.gui:main",
          "",
          "[console_scripts]",
          "# nested comment",
          "real-entry = mcp_server.cli:main",
        ].join("\n"),
      );
      expect(await pickPypiEntryPoint(workDir, "mcp-server")).toBe("real-entry");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("throws ENTRY_MISSING when no console_scripts entry exists", async () => {
    workDir = await mkdtemp(join(tmpdir(), "afps-pypi-ep-"));
    try {
      await writeEntryPoints(
        "mcp_server-1.2.0.dist-info",
        "[gui_scripts]\nonly-gui = mcp_server.gui:main\n",
      );
      const err = await pickPypiEntryPoint(workDir, "mcp-server").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundlerError);
      expect((err as BundlerError).code).toBe("ENTRY_MISSING");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("throws ENTRY_MISSING when there is no dist-info at all", async () => {
    workDir = await mkdtemp(join(tmpdir(), "afps-pypi-ep-"));
    try {
      // Empty target tree — readdir finds no `*.dist-info`, so no entry point.
      const err = await pickPypiEntryPoint(workDir, "mcp-server").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundlerError);
      expect((err as BundlerError).code).toBe("ENTRY_MISSING");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("scans multiple dist-info dirs and returns the first console_scripts entry found", async () => {
    workDir = await mkdtemp(join(tmpdir(), "afps-pypi-ep-"));
    try {
      // A dependency dist-info without console_scripts, plus the target one
      // that has it. The resolver must skip the former and find the latter.
      await writeEntryPoints("dep_lib-3.0.0.dist-info", "[gui_scripts]\ndep-gui = dep_lib:gui\n");
      await writeEntryPoints(
        "mcp_server-1.2.0.dist-info",
        "[console_scripts]\nmcp-server = mcp_server.cli:main\n",
      );
      expect(await pickPypiEntryPoint(workDir, "mcp-server")).toBe("mcp-server");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
