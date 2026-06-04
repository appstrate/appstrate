// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Branch coverage for the npm / pypi vendoring resolvers' version-resolution
 * and full-pass orchestration, exercised through the injectable `fetchRegistry`
 * / `installPackage` boundaries (no network, no real installer).
 *
 *   - `resolveNpmVersion` / `resolvePypiVersion` — registry-shape, missing
 *     version, and missing integrity error branches + the happy path.
 *   - `vendorNpmPackage` / `vendorPypiPackage` — full pass that materialises a
 *     fixture tree via the injected installer, collects it, and rewrites the
 *     server section. Covers the npm install-tree-missing / parse-error guards.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveNpmVersion,
  vendorNpmPackage,
  BundlerError,
  type NpmInstallSpec,
} from "../src/mcp-server-bundle/npm-vendor.ts";
import {
  resolvePypiVersion,
  vendorPypiPackage,
  type PypiInstallSpec,
} from "../src/mcp-server-bundle/pypi-vendor.ts";

function errCode(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "NO_ERROR",
    (e: unknown) => (e instanceof BundlerError ? e.code : `WRONG_ERROR:${String(e)}`),
  );
}

describe("resolveNpmVersion", () => {
  it("returns version + integrity + tarball on a well-formed packument", async () => {
    const res = await resolveNpmVersion(
      { identifier: "@scope/srv", versionRange: "1.2.3" },
      {
        fetchRegistry: async () => ({
          name: "@scope/srv",
          version: "1.2.3",
          dist: { integrity: "sha512-abc", tarball: "https://x/srv.tgz" },
        }),
      },
    );
    expect(res).toEqual({
      version: "1.2.3",
      integrity: "sha512-abc",
      tarball: "https://x/srv.tgz",
    });
  });

  it("escapes the scope slash + encodes the range in the request URL", async () => {
    let seenUrl = "";
    await resolveNpmVersion(
      { identifier: "@scope/srv", versionRange: "latest" },
      {
        fetchRegistry: async (url) => {
          seenUrl = url;
          return { name: "@scope/srv", version: "9.0.0", dist: { integrity: "sha512-z" } };
        },
      },
    );
    expect(seenUrl).toBe("https://registry.npmjs.org/@scope%2Fsrv/latest");
  });

  it("throws REGISTRY_SHAPE when the response is not an object", async () => {
    expect(
      await errCode(
        resolveNpmVersion(
          { identifier: "srv", versionRange: "1.0.0" },
          { fetchRegistry: async () => null },
        ),
      ),
    ).toBe("REGISTRY_SHAPE");
  });

  it("throws REGISTRY_NO_VERSION when version is absent", async () => {
    expect(
      await errCode(
        resolveNpmVersion(
          { identifier: "srv", versionRange: "1.0.0" },
          { fetchRegistry: async () => ({ name: "srv", dist: { integrity: "sha512-x" } }) },
        ),
      ),
    ).toBe("REGISTRY_NO_VERSION");
  });

  it("throws REGISTRY_NO_INTEGRITY when dist.integrity is absent", async () => {
    expect(
      await errCode(
        resolveNpmVersion(
          { identifier: "srv", versionRange: "1.0.0" },
          { fetchRegistry: async () => ({ name: "srv", version: "1.0.0", dist: {} }) },
        ),
      ),
    ).toBe("REGISTRY_NO_INTEGRITY");
  });
});

describe("vendorNpmPackage", () => {
  // Installer that lays down a minimal runnable node_modules tree on disk.
  function fixtureInstaller(pkgJson: object, extraFiles: Record<string, string> = {}) {
    return async (spec: NpmInstallSpec) => {
      const root = join(spec.targetDir, "node_modules", spec.identifier);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify(pkgJson), "utf8");
      for (const [rel, content] of Object.entries(extraFiles)) {
        const abs = join(root, rel);
        await mkdir(join(abs, ".."), { recursive: true });
        await writeFile(abs, content, "utf8");
      }
    };
  }

  it("vendors a tree, rewrites the server section, and records provenance", async () => {
    const work = await mkdtemp(join(tmpdir(), "afps-vendor-npm-"));
    try {
      const res = await vendorNpmPackage(
        { identifier: "srv", versionRange: "1.0.0" },
        {
          workRoot: work,
          fetchRegistry: async () => ({
            name: "srv",
            version: "1.0.0",
            dist: { integrity: "sha512-int" },
          }),
          installPackage: fixtureInstaller(
            { name: "srv", version: "1.0.0", bin: "./cli.js" },
            { "cli.js": "#!/usr/bin/env node\n" },
          ),
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        },
      );
      expect(res.rewrittenServerType).toBe("node");
      // entry_point preserves the raw `bin` string (`./cli.js`) verbatim.
      expect(res.rewrittenEntryPoint).toBe("./server/node_modules/srv/./cli.js");
      expect(res.files["server/node_modules/srv/cli.js"]).toBeInstanceOf(Uint8Array);
      expect(res.files["server/node_modules/srv/package.json"]).toBeInstanceOf(Uint8Array);
      expect(res.resolution).toEqual({
        registryType: "npm",
        identifier: "srv",
        versionRequested: "1.0.0",
        versionResolved: "1.0.0",
        integrity: "sha512-int",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("throws INSTALL_TREE_MISSING when the installer produces no package.json", async () => {
    const work = await mkdtemp(join(tmpdir(), "afps-vendor-npm-"));
    try {
      expect(
        await errCode(
          vendorNpmPackage(
            { identifier: "srv", versionRange: "1.0.0" },
            {
              workRoot: work,
              fetchRegistry: async () => ({
                name: "srv",
                version: "1.0.0",
                dist: { integrity: "sha512-int" },
              }),
              installPackage: async () => {}, // no-op: tree never materialises
            },
          ),
        ),
      ).toBe("INSTALL_TREE_MISSING");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("throws INSTALL_TREE_PARSE when the installed package.json is invalid JSON", async () => {
    const work = await mkdtemp(join(tmpdir(), "afps-vendor-npm-"));
    try {
      const badInstaller = async (spec: NpmInstallSpec) => {
        const root = join(spec.targetDir, "node_modules", spec.identifier);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "package.json"), "{ not json", "utf8");
      };
      expect(
        await errCode(
          vendorNpmPackage(
            { identifier: "srv", versionRange: "1.0.0" },
            {
              workRoot: work,
              fetchRegistry: async () => ({
                name: "srv",
                version: "1.0.0",
                dist: { integrity: "sha512-int" },
              }),
              installPackage: badInstaller,
            },
          ),
        ),
      ).toBe("INSTALL_TREE_PARSE");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("throws ENTRY_MISSING when the resolved entry file is absent on disk", async () => {
    const work = await mkdtemp(join(tmpdir(), "afps-vendor-npm-"));
    try {
      expect(
        await errCode(
          vendorNpmPackage(
            { identifier: "srv", versionRange: "1.0.0" },
            {
              workRoot: work,
              fetchRegistry: async () => ({
                name: "srv",
                version: "1.0.0",
                dist: { integrity: "sha512-int" },
              }),
              // package.json points bin at a file that was never written.
              installPackage: fixtureInstaller({
                name: "srv",
                version: "1.0.0",
                bin: "./missing.js",
              }),
            },
          ),
        ),
      ).toBe("ENTRY_MISSING");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("resolvePypiVersion", () => {
  it("prefers the sdist sha256 and returns a sha256-prefixed integrity", async () => {
    const res = await resolvePypiVersion(
      { identifier: "mcp-srv", versionRange: "2.0.0" },
      {
        fetchRegistry: async () => ({
          info: { name: "mcp-srv", version: "2.0.0" },
          urls: [
            { packagetype: "bdist_wheel", digests: { sha256: "wheelhash" }, filename: "x.whl" },
            { packagetype: "sdist", digests: { sha256: "sdisthash" }, filename: "x.tar.gz" },
          ],
        }),
      },
    );
    expect(res).toEqual({ version: "2.0.0", integrity: "sha256-sdisthash" });
  });

  it("falls back to the first url's hash when no sdist is present", async () => {
    const res = await resolvePypiVersion(
      { identifier: "mcp-srv", versionRange: "2.0.0" },
      {
        fetchRegistry: async () => ({
          info: { name: "mcp-srv", version: "2.0.0" },
          urls: [
            { packagetype: "bdist_wheel", digests: { sha256: "onlyhash" }, filename: "x.whl" },
          ],
        }),
      },
    );
    expect(res.integrity).toBe("sha256-onlyhash");
  });

  it("throws REGISTRY_SHAPE on a non-object response", async () => {
    expect(
      await errCode(
        resolvePypiVersion(
          { identifier: "p", versionRange: "1.0.0" },
          { fetchRegistry: async () => 42 },
        ),
      ),
    ).toBe("REGISTRY_SHAPE");
  });

  it("throws REGISTRY_NO_VERSION when info.version is absent", async () => {
    expect(
      await errCode(
        resolvePypiVersion(
          { identifier: "p", versionRange: "1.0.0" },
          { fetchRegistry: async () => ({ info: { name: "p" }, urls: [] }) },
        ),
      ),
    ).toBe("REGISTRY_NO_VERSION");
  });

  it("throws REGISTRY_NO_INTEGRITY when no url carries a sha256", async () => {
    expect(
      await errCode(
        resolvePypiVersion(
          { identifier: "p", versionRange: "1.0.0" },
          {
            fetchRegistry: async () => ({
              info: { name: "p", version: "1.0.0" },
              urls: [{ packagetype: "sdist", filename: "x.tar.gz" }],
            }),
          },
        ),
      ),
    ).toBe("REGISTRY_NO_INTEGRITY");
  });
});

describe("vendorPypiPackage", () => {
  it("installs, discovers the console_scripts entry, and rewrites to binary", async () => {
    const work = await mkdtemp(join(tmpdir(), "afps-vendor-pypi-"));
    try {
      const installer = async (spec: PypiInstallSpec) => {
        // dist-info with a console_scripts entry + a stub module file.
        const distInfo = join(spec.targetDir, "mcp_srv-3.1.0.dist-info");
        await mkdir(distInfo, { recursive: true });
        await writeFile(
          join(distInfo, "entry_points.txt"),
          "[console_scripts]\nmcp-srv = mcp_srv.cli:main\n",
          "utf8",
        );
        const pkg = join(spec.targetDir, "mcp_srv");
        await mkdir(pkg, { recursive: true });
        await writeFile(join(pkg, "__init__.py"), "", "utf8");
        // __pycache__ entries must be skipped by collectFiles.
        const cache = join(pkg, "__pycache__");
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, "x.pyc"), "ignored", "utf8");
      };
      const res = await vendorPypiPackage(
        { identifier: "mcp-srv", versionRange: "3.1.0" },
        {
          workRoot: work,
          fetchRegistry: async () => ({
            info: { name: "mcp-srv", version: "3.1.0" },
            urls: [{ packagetype: "sdist", digests: { sha256: "h" }, filename: "x.tar.gz" }],
          }),
          installPackage: installer,
          now: () => new Date("2026-02-02T00:00:00.000Z"),
        },
      );
      expect(res.rewrittenServerType).toBe("binary");
      expect(res.rewrittenEntryPoint).toBe("./server/bin/mcp-srv");
      expect(res.files["server/mcp_srv/__init__.py"]).toBeInstanceOf(Uint8Array);
      // __pycache__ is excluded.
      expect(Object.keys(res.files).some((k) => k.includes("__pycache__"))).toBe(false);
      expect(res.resolution.registryType).toBe("pypi");
      expect(res.resolution.integrity).toBe("sha256-h");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
