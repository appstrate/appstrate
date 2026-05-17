// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the integration bundler (Phase 1.05).
 *
 * Network and subprocess access are stubbed via the bundler's
 * injectable dependencies so every test is hermetic. End-to-end
 * integration with live npm / pypi is exercised by the separate
 * `integration-bundle-fixtures` suite (gated on a real installer
 * being available) — these tests cover the pure pipeline.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleIntegration,
  BundlerError,
  packDeterministicZip,
  rewriteManifestForDistribution,
  suggestBundleFileName,
} from "../src/integration-bundle/index.ts";
import { unzipArtifact } from "../src/zip.ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function authorManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/widget",
    version: "1.0.0",
    displayName: "Widget",
    server: {
      type: "npx",
      package: {
        registryType: "npm",
        identifier: "@modelcontextprotocol/server-widget",
        version: "^1.0.0",
      },
    },
    ...overrides,
  };
}

function manifestFromTree(tree: Record<string, Uint8Array>): Record<string, unknown> {
  const raw = tree["manifest.json"];
  if (!raw) throw new Error("bundle missing manifest.json");
  return JSON.parse(DEC.decode(raw)) as Record<string, unknown>;
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
  it("escapes scope separators", () => {
    expect(suggestBundleFileName({ name: "@official/widget", version: "1.2.3" } as never)).toBe(
      "official__widget@1.2.3.afps",
    );
  });
  it("handles unscoped names", () => {
    expect(suggestBundleFileName({ name: "widget", version: "0.0.1" } as never)).toBe(
      "widget@0.0.1.afps",
    );
  });
});

describe("rewriteManifestForDistribution", () => {
  it("strips server.package and pins type+entryPoint", () => {
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
    expect(rewritten.server.type).toBe("node");
    expect(rewritten.server.entryPoint).toBe("./server/node_modules/x/dist/bin.js");
    expect(rewritten.server.package).toBeUndefined();
    const meta = (rewritten._meta as Record<string, unknown>) ?? {};
    const res = meta.sourceResolution as Record<string, unknown>;
    expect(res.versionResolved).toBe("1.4.2");
    expect(res.integrity).toBe("sha512-abc");
  });

  it("encodes bunCompat=false + reason", () => {
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
    const meta = (rewritten._meta as Record<string, unknown>) ?? {};
    expect(meta.bunCompat).toBe(false);
    expect(meta.bunCompatReason).toBe("exited before MCP handshake");
  });
});

describe("bundleIntegration — author sugars", () => {
  it("validates and rejects an invalid manifest", async () => {
    await expect(
      bundleIntegration({
        manifest: { type: "integration", name: "broken" },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("bundles an already-vendored manifest (no package) without network", async () => {
    const result = await bundleIntegration({
      manifest: authorManifest({
        server: { type: "npx", entryPoint: "./server/index.js" },
      }),
      prebuiltServerFiles: {
        "server/index.js": ENC.encode("#!/usr/bin/env node\nconsole.log(1);\n"),
      },
    });
    expect(result.manifest.server.type).toBe("node");
    expect(result.manifest.server.entryPoint).toBe("./server/index.js");
    const out = unzipArtifact(result.afps);
    expect(out["server/index.js"]).toBeDefined();
    const distributed = manifestFromTree(out);
    expect(distributed.server).toMatchObject({ type: "node", entryPoint: "./server/index.js" });
  });

  it("rejects conflicting prebuilt files vs vendored files", async () => {
    let installCalled = false;
    await expect(
      bundleIntegration({
        manifest: authorManifest({
          server: {
            type: "npx",
            package: {
              registryType: "npm",
              identifier: "@modelcontextprotocol/server-widget",
              version: "1.0.0",
            },
          },
        }),
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
      bundleIntegration({
        manifest: authorManifest({
          server: { type: "node", entryPoint: "./server/index.js" },
        }),
        extraFiles: { "manifest.json": ENC.encode("{}") },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("uses npm resolver with stubbed deps and rewrites to node", async () => {
    const result = await bundleIntegration({
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

    expect(result.manifest.server.type).toBe("node");
    expect(result.manifest.server.entryPoint).toBe(
      "./server/node_modules/@modelcontextprotocol/server-widget/dist/bin.js",
    );
    expect(result.manifest.server.package).toBeUndefined();
    const meta = (result.manifest._meta as Record<string, unknown>) ?? {};
    const res = meta.sourceResolution as Record<string, unknown>;
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

  it("uses pypi resolver with stubbed deps and rewrites to uv", async () => {
    const result = await bundleIntegration({
      manifest: authorManifest({
        server: {
          type: "uvx",
          package: {
            registryType: "pypi",
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

    expect(result.manifest.server.type).toBe("uv");
    expect(result.manifest.server.entryPoint).toBe("./server/bin/mcp-server-git");
    expect(result.manifest.server.package).toBeUndefined();
    const meta = (result.manifest._meta as Record<string, unknown>) ?? {};
    const res = meta.sourceResolution as Record<string, unknown>;
    expect(res).toMatchObject({
      registryType: "pypi",
      identifier: "mcp-server-git",
      versionResolved: "0.6.2",
      integrity: "sha256-deadbeef",
    });
  });

  it("surfaces registry HTTP errors as BundlerError", async () => {
    await expect(
      bundleIntegration({
        manifest: authorManifest(),
        npmDeps: {
          fetchRegistry: async () => {
            throw new BundlerError("HTTP 500", "REGISTRY_HTTP");
          },
          installPackage: async () => {
            // Should never be reached.
            throw new Error("install should not have been called");
          },
        },
      }),
    ).rejects.toBeInstanceOf(BundlerError);
  });

  it("surfaces install failures as BundlerError", async () => {
    await expect(
      bundleIntegration({
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
      bundleIntegration({
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
      bundleIntegration({
        manifest: authorManifest({
          server: { type: "node", entryPoint: "./server/index.js" },
        }),
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

describe("bundleIntegration — direct types (no sugar)", () => {
  it("packages a node manifest verbatim", async () => {
    const result = await bundleIntegration({
      manifest: authorManifest({
        server: { type: "node", entryPoint: "./server/index.js" },
      }),
      prebuiltServerFiles: {
        "server/index.js": ENC.encode("/* mcp */\n"),
      },
    });
    expect(result.manifest.server.type).toBe("node");
    const out = unzipArtifact(result.afps);
    expect(out["server/index.js"]).toBeDefined();
  });

  it("packages a docker manifest with no vendoring", async () => {
    const docDigest = "sha256:" + "a".repeat(64);
    const result = await bundleIntegration({
      manifest: authorManifest({
        server: {
          type: "docker",
          package: { registryType: "oci", identifier: "ghcr.io/x/y", digest: docDigest },
        },
      }),
      extraFiles: {
        "INTEGRATION.md": ENC.encode("# x\n"),
      },
    });
    expect(result.manifest.server.type).toBe("docker");
    const out = unzipArtifact(result.afps);
    expect(out["INTEGRATION.md"]).toBeDefined();
  });

  it("packages an http manifest", async () => {
    const result = await bundleIntegration({
      manifest: authorManifest({
        server: { type: "http", url: "https://api.example.com/mcp" },
        transport: { type: "streamable-http" },
      }),
    });
    expect(result.manifest.server.type).toBe("http");
    expect(result.manifest.server.url).toBe("https://api.example.com/mcp");
  });
});

describe("npm vendor — filesystem behavior under stub install", () => {
  it("collects every file under node_modules into server/", async () => {
    let workDir = "";
    const result = await bundleIntegration({
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
      await bundleIntegration({
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
