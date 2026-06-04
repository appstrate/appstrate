// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the mcp-server bundler.
 *
 * Network and subprocess access are stubbed via the bundler's injectable
 * dependencies so every test is hermetic. The bundler reads an author-time
 * MCPB (`mcp-server`) manifest, vendors the author-sugar npm/pypi source
 * declared under `_meta["dev.appstrate/vendor"]`, and emits a deterministic
 * `.afps` archive.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleMcpServer,
  BundlerError,
  packDeterministicZip,
  readVendorSource,
  rewriteManifestForDistribution,
  suggestBundleFileName,
} from "../src/mcp-server-bundle/index.ts";
import { unzipArtifact } from "../src/zip.ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * A valid author-time MCPB (`mcp-server`) manifest (AFPS). The
 * vendoring source is declared under `_meta["dev.appstrate/vendor"]`. AFPS
 * (§3.4) lifted the scoped identity (`name`, `type`, `schema_version`)
 * to the manifest root.
 */
function authorManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: "0.3",
    name: "@official/widget",
    version: "1.0.0",
    type: "mcp-server",
    schema_version: "0.1",
    display_name: "Widget Server",
    server: {
      type: "node",
      entry_point: "./server/index.js",
      mcp_config: { command: "node", args: ["./server/index.js"] },
    },
    _meta: {
      "dev.appstrate/vendor": {
        source: "npm",
        identifier: "@modelcontextprotocol/server-widget",
        version: "^1.0.0",
      },
    },
  };
  // Allow overriding `server` / `_meta` wholesale.
  return { ...base, ...overrides };
}

/** A self-contained MCPB manifest (no vendoring source) — packaged verbatim. */
function selfContainedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "@official/widget",
    version: "1.0.0",
    type: "mcp-server",
    schema_version: "0.1",
    display_name: "Widget Server",
    server: {
      type: "node",
      entry_point: "./server/index.js",
      mcp_config: { command: "node", args: ["./server/index.js"] },
    },
    ...overrides,
  };
}

function manifestFromTree(tree: Record<string, Uint8Array>): Record<string, unknown> {
  const raw = tree["manifest.json"];
  if (!raw) throw new Error("bundle missing manifest.json");
  return JSON.parse(DEC.decode(raw)) as Record<string, unknown>;
}

function serverOf(m: { server?: unknown }): Record<string, unknown> {
  return (m.server ?? {}) as Record<string, unknown>;
}
function metaOf(m: { _meta?: unknown }): Record<string, unknown> {
  return (m._meta ?? {}) as Record<string, unknown>;
}

describe("packDeterministicZip", () => {
  it("produces identical bytes for identical inputs", () => {
    const a = packDeterministicZip({
      "a.txt": ENC.encode("hello"),
      "b.txt": ENC.encode("world"),
    });
    const b = packDeterministicZip({
      "a.txt": ENC.encode("hello"),
      "b.txt": ENC.encode("world"),
    });
    expect(a).toEqual(b);
  });

  it("is insensitive to input key order", () => {
    const a = packDeterministicZip({
      "z.txt": ENC.encode("z"),
      "a.txt": ENC.encode("a"),
    });
    const b = packDeterministicZip({
      "a.txt": ENC.encode("a"),
      "z.txt": ENC.encode("z"),
    });
    expect(a).toEqual(b);
  });

  it("round-trips through unzipArtifact", () => {
    const tree = {
      "manifest.json": ENC.encode('{"hello":"world"}'),
      "server/index.js": ENC.encode("console.log(1);\n"),
    };
    const zip = packDeterministicZip(tree);
    const out = unzipArtifact(zip);
    expect(Object.keys(out).sort()).toEqual(["manifest.json", "server/index.js"]);
    expect(DEC.decode(out["manifest.json"]!)).toBe('{"hello":"world"}');
  });
});

describe("suggestBundleFileName", () => {
  it("uses the scoped root identity, escaping scope separators", () => {
    // AFPS (§3.4): the scoped identity lives at the manifest root.
    expect(
      suggestBundleFileName({
        name: "@official/widget",
        version: "1.2.3",
        type: "mcp-server",
      } as never),
    ).toBe("official__widget@1.2.3.afps");
  });
  it("handles an unscoped root name as a flat filename", () => {
    expect(suggestBundleFileName({ name: "widget", version: "0.0.1" } as never)).toBe(
      "widget@0.0.1.afps",
    );
  });
});

describe("rewriteManifestForDistribution", () => {
  it("strips the vendor intent and pins server.type + entry_point", () => {
    const source = authorManifest() as never;
    const rewritten = rewriteManifestForDistribution(source, {
      files: {},
      rewrittenServerType: "node",
      rewrittenEntryPoint: "./server/node_modules/x/dist/bin.js",
      resolution: {
        registryType: "npm",
        identifier: "x",
        versionRequested: "^1.0.0",
        versionResolved: "1.4.2",
        integrity: "sha512-abc",
        resolvedAt: "2026-05-17T10:00:00.000Z",
      },
    });
    const server = serverOf(rewritten);
    expect(server.type).toBe("node");
    expect(server.entry_point).toBe("./server/node_modules/x/dist/bin.js");
    const meta = metaOf(rewritten);
    expect(meta["dev.appstrate/vendor"]).toBeUndefined();
    const res = meta["dev.appstrate/source-resolution"] as Record<string, unknown>;
    expect(res.versionResolved).toBe("1.4.2");
    expect(res.integrity).toBe("sha512-abc");
  });

  it("encodes bun-compat=false + reason", () => {
    const source = authorManifest() as never;
    const rewritten = rewriteManifestForDistribution(
      source,
      {
        files: {},
        rewrittenServerType: "node",
        rewrittenEntryPoint: "./server/x.js",
        resolution: {
          registryType: "npm",
          identifier: "x",
          versionRequested: "*",
          versionResolved: "1.0.0",
          integrity: "sha512-y",
          resolvedAt: "2026-05-17T10:00:00.000Z",
        },
      },
      { ok: false, reason: "exited before MCP handshake" },
    );
    const meta = metaOf(rewritten);
    const bunCompat = meta["dev.appstrate/bun-compat"] as Record<string, unknown>;
    expect(bunCompat.ok).toBe(false);
    expect(bunCompat.reason).toBe("exited before MCP handshake");
  });
});

describe("bundleMcpServer — author sugars", () => {
  it("validates and rejects an invalid manifest", async () => {
    await expect(
      bundleMcpServer({
        manifest: { manifest_version: "0.3", name: "broken" },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("bundles a self-contained manifest (no vendor source) without network", async () => {
    const result = await bundleMcpServer({
      manifest: selfContainedManifest(),
      prebuiltServerFiles: {
        "server/index.js": ENC.encode("#!/usr/bin/env node\nconsole.log(1);\n"),
      },
    });
    expect(serverOf(result.manifest).type).toBe("node");
    expect(serverOf(result.manifest).entry_point).toBe("./server/index.js");
    const out = unzipArtifact(result.afps);
    expect(out["server/index.js"]).toBeDefined();
    const distributed = manifestFromTree(out);
    expect(serverOf(distributed)).toMatchObject({
      type: "node",
      entry_point: "./server/index.js",
    });
  });

  it("rejects conflicting prebuilt files vs vendored files", async () => {
    let installCalled = false;
    await expect(
      bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => ({
            name: "@modelcontextprotocol/server-widget",
            version: "1.0.0",
            dist: { integrity: "sha512-abc" },
          }),
          installPackage: async ({ targetDir }) => {
            installCalled = true;
            const pkgDir = join(
              targetDir,
              "node_modules",
              "@modelcontextprotocol",
              "server-widget",
            );
            await mkdir(pkgDir, { recursive: true });
            await writeFile(
              join(pkgDir, "package.json"),
              JSON.stringify({ name: "@modelcontextprotocol/server-widget", main: "index.js" }),
            );
            await writeFile(join(pkgDir, "index.js"), "console.log(1);\n");
          },
        },
        prebuiltServerFiles: {
          "server/node_modules/@modelcontextprotocol/server-widget/index.js": ENC.encode("x"),
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
    expect(installCalled).toBe(true);
  });

  it("rejects extraFiles overriding manifest.json", async () => {
    await expect(
      bundleMcpServer({
        manifest: selfContainedManifest(),
        extraFiles: { "manifest.json": ENC.encode("{}") },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("uses npm resolver with stubbed deps and rewrites to node", async () => {
    const result = await bundleMcpServer({
      manifest: authorManifest(),
      npmDeps: {
        fetchRegistry: async (url: string) => {
          expect(url).toMatch(/registry\.npmjs\.org/);
          return {
            name: "@modelcontextprotocol/server-widget",
            version: "1.4.2",
            bin: { "server-widget": "dist/bin.js" },
            dist: { integrity: "sha512-fakeintegrity" },
          };
        },
        installPackage: async ({ identifier, version, targetDir }) => {
          expect(identifier).toBe("@modelcontextprotocol/server-widget");
          expect(version).toBe("1.4.2");
          const pkgDir = join(targetDir, "node_modules", identifier, "dist");
          await mkdir(pkgDir, { recursive: true });
          await writeFile(
            join(targetDir, "node_modules", identifier, "package.json"),
            JSON.stringify({
              name: identifier,
              bin: { "server-widget": "dist/bin.js" },
            }),
          );
          await writeFile(join(pkgDir, "bin.js"), "#!/usr/bin/env node\nconsole.log(2);\n");
        },
        now: () => new Date("2026-05-17T10:00:00.000Z"),
      },
    });

    const server = serverOf(result.manifest);
    expect(server.type).toBe("node");
    expect(server.entry_point).toBe(
      "./server/node_modules/@modelcontextprotocol/server-widget/dist/bin.js",
    );
    const meta = metaOf(result.manifest);
    expect(meta["dev.appstrate/vendor"]).toBeUndefined();
    const res = meta["dev.appstrate/source-resolution"] as Record<string, unknown>;
    expect(res).toMatchObject({
      registryType: "npm",
      identifier: "@modelcontextprotocol/server-widget",
      versionRequested: "^1.0.0",
      versionResolved: "1.4.2",
      integrity: "sha512-fakeintegrity",
      resolvedAt: "2026-05-17T10:00:00.000Z",
    });

    const out = unzipArtifact(result.afps);
    expect(Object.keys(out).some((k) => k.endsWith("/dist/bin.js"))).toBe(true);
    expect(out["manifest.json"]).toBeDefined();
  });

  it("uses pypi resolver with stubbed deps and rewrites to binary", async () => {
    const result = await bundleMcpServer({
      manifest: authorManifest({
        name: "@official/git",
        _meta: {
          "dev.appstrate/vendor": {
            source: "pypi",
            identifier: "mcp-server-git",
            version: "0.6.2",
          },
        },
      }),
      pypiDeps: {
        fetchRegistry: async (url: string) => {
          expect(url).toMatch(/pypi\.org/);
          return {
            info: { name: "mcp-server-git", version: "0.6.2" },
            urls: [{ packagetype: "sdist", digests: { sha256: "deadbeef" }, filename: "x.tar.gz" }],
          };
        },
        installPackage: async ({ identifier, version, targetDir }) => {
          expect(identifier).toBe("mcp-server-git");
          expect(version).toBe("0.6.2");
          const distInfo = join(targetDir, "mcp_server_git-0.6.2.dist-info");
          await mkdir(distInfo, { recursive: true });
          await writeFile(
            join(distInfo, "entry_points.txt"),
            "[console_scripts]\nmcp-server-git = mcp_server_git.cli:main\n",
          );
          await mkdir(join(targetDir, "bin"), { recursive: true });
          await writeFile(
            join(targetDir, "bin", "mcp-server-git"),
            "#!/usr/bin/env python\nimport mcp_server_git.cli\n",
          );
        },
        now: () => new Date("2026-05-17T10:00:00.000Z"),
      },
    });

    const server = serverOf(result.manifest);
    expect(server.type).toBe("binary");
    expect(server.entry_point).toBe("./server/bin/mcp-server-git");
    const meta = metaOf(result.manifest);
    const res = meta["dev.appstrate/source-resolution"] as Record<string, unknown>;
    expect(res).toMatchObject({
      registryType: "pypi",
      identifier: "mcp-server-git",
      versionResolved: "0.6.2",
      integrity: "sha256-deadbeef",
    });
  });

  it("surfaces registry HTTP errors as BundlerError", async () => {
    await expect(
      bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => {
            throw new BundlerError("HTTP 500", "REGISTRY_HTTP");
          },
          installPackage: async () => {
            throw new Error("install should not have been called");
          },
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("surfaces install failures as BundlerError", async () => {
    await expect(
      bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => ({
            name: "@modelcontextprotocol/server-widget",
            version: "1.0.0",
            dist: { integrity: "sha512-abc" },
          }),
          installPackage: async () => {
            throw new BundlerError("npm install exit 1", "NPM_INSTALL");
          },
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("rejects npm registry response missing integrity", async () => {
    await expect(
      bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => ({
            name: "@modelcontextprotocol/server-widget",
            version: "1.0.0",
            dist: {},
          }),
          installPackage: async () => {
            throw new Error("install should not have been called");
          },
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("produces a deterministic ZIP byte-for-byte across runs", async () => {
    const make = () =>
      bundleMcpServer({
        manifest: selfContainedManifest(),
        prebuiltServerFiles: {
          "server/index.js": ENC.encode("console.log(42);\n"),
        },
      });
    const a = await make();
    const b = await make();
    expect(a.afps).toEqual(b.afps);
    expect(a.suggestedFileName).toBe(b.suggestedFileName);
  });
});

describe("bundleMcpServer — self-contained (no vendor source)", () => {
  it("packages a node manifest verbatim", async () => {
    const result = await bundleMcpServer({
      manifest: selfContainedManifest(),
      prebuiltServerFiles: {
        "server/index.js": ENC.encode("/* mcp */\n"),
      },
    });
    expect(serverOf(result.manifest).type).toBe("node");
    const out = unzipArtifact(result.afps);
    expect(out["server/index.js"]).toBeDefined();
  });

  it("packages a binary manifest with a companion doc and no vendoring", async () => {
    const result = await bundleMcpServer({
      manifest: selfContainedManifest({
        server: {
          type: "binary",
          entry_point: "./server/bin/run",
          mcp_config: { command: "./server/bin/run", args: [] },
        },
      }),
      prebuiltServerFiles: { "server/bin/run": ENC.encode("#!/bin/sh\n") },
      extraFiles: { "SERVER.md": ENC.encode("# x\n") },
    });
    expect(serverOf(result.manifest).type).toBe("binary");
    const out = unzipArtifact(result.afps);
    expect(out["SERVER.md"]).toBeDefined();
  });
});

describe("npm vendor — filesystem behavior under stub install", () => {
  it("collects every file under node_modules into server/", async () => {
    let workDir = "";
    const result = await bundleMcpServer({
      manifest: authorManifest(),
      npmDeps: {
        fetchRegistry: async () => ({
          name: "@modelcontextprotocol/server-widget",
          version: "1.0.0",
          dist: { integrity: "sha512-abc" },
        }),
        installPackage: async (spec) => {
          workDir = spec.targetDir;
          const pkgDir = join(spec.targetDir, "node_modules", spec.identifier);
          await mkdir(pkgDir, { recursive: true });
          await writeFile(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: spec.identifier, main: "index.js" }),
          );
          await writeFile(join(pkgDir, "index.js"), "/* main */\n");
          await mkdir(join(pkgDir, "subdir"), { recursive: true });
          await writeFile(join(pkgDir, "subdir", "child.js"), "/* child */\n");
        },
      },
    });
    expect(workDir).toMatch(/afps-bundle-npm-/);
    const out = unzipArtifact(result.afps);
    const keys = Object.keys(out)
      .filter((k) => k.startsWith("server/"))
      .sort();
    expect(keys).toContain("server/node_modules/@modelcontextprotocol/server-widget/package.json");
    expect(keys).toContain("server/node_modules/@modelcontextprotocol/server-widget/index.js");
    expect(keys).toContain(
      "server/node_modules/@modelcontextprotocol/server-widget/subdir/child.js",
    );
    // Work dir should be cleaned up by default.
    await expect(stat(workDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the work dir when keepWorkDir: true", async () => {
    let workDir = "";
    const workRoot = await mkdtemp(join(tmpdir(), "afps-test-"));
    try {
      await bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => ({
            name: "@modelcontextprotocol/server-widget",
            version: "1.0.0",
            dist: { integrity: "sha512-abc" },
          }),
          installPackage: async (spec) => {
            workDir = spec.targetDir;
            const pkgDir = join(spec.targetDir, "node_modules", spec.identifier);
            await mkdir(pkgDir, { recursive: true });
            await writeFile(
              join(pkgDir, "package.json"),
              JSON.stringify({ name: spec.identifier, main: "index.js" }),
            );
            await writeFile(join(pkgDir, "index.js"), "/* main */\n");
          },
          workRoot,
          keepWorkDir: true,
        },
      });
      const dirEntries = await readdir(workDir);
      expect(dirEntries).toContain("node_modules");
      const installed = await readFile(
        join(workDir, "node_modules", "@modelcontextprotocol", "server-widget", "index.js"),
        "utf8",
      );
      expect(installed).toContain("main");
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("readVendorSource", () => {
  it("returns null when no vendor _meta is present (self-contained)", () => {
    expect(readVendorSource(selfContainedManifest() as never)).toBeNull();
  });

  it("rejects an unknown vendor source kind", () => {
    const m = authorManifest({
      _meta: {
        "dev.appstrate/vendor": { source: "cargo", identifier: "x", version: "1.0.0" },
      },
    });
    expect(() => readVendorSource(m as never)).toThrow(BundlerError);
  });

  it("rejects a vendor source missing its identifier", () => {
    const m = authorManifest({
      _meta: {
        "dev.appstrate/vendor": { source: "npm", version: "1.0.0" },
      },
    });
    expect(() => readVendorSource(m as never)).toThrow(BundlerError);
  });

  it("rejects a vendor source missing its version", () => {
    const m = authorManifest({
      _meta: {
        "dev.appstrate/vendor": { source: "pypi", identifier: "x" },
      },
    });
    expect(() => readVendorSource(m as never)).toThrow(BundlerError);
  });
});

describe("bundleMcpServer — extraFiles conflict", () => {
  it("rejects extraFiles that collide with a vendored file", async () => {
    await expect(
      bundleMcpServer({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => ({
            name: "@modelcontextprotocol/server-widget",
            version: "1.0.0",
            dist: { integrity: "sha512-abc" },
          }),
          installPackage: async ({ targetDir }) => {
            const pkgDir = join(
              targetDir,
              "node_modules",
              "@modelcontextprotocol",
              "server-widget",
            );
            await mkdir(pkgDir, { recursive: true });
            await writeFile(
              join(pkgDir, "package.json"),
              JSON.stringify({ name: "@modelcontextprotocol/server-widget", main: "index.js" }),
            );
            await writeFile(join(pkgDir, "index.js"), "console.log(1);\n");
          },
        },
        extraFiles: {
          "server/node_modules/@modelcontextprotocol/server-widget/index.js": ENC.encode("x"),
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });
});
