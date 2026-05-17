// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * End-to-end tests for the `afps bundle` CLI command.
 *
 * The CLI dispatches into `@appstrate/core/integration-bundle`, which
 * is resolvable here because both packages share the workspace's
 * `node_modules`. The pure pipeline is covered by the bundler's own
 * unit tests in `packages/core/test/integration-bundle.test.ts` — this
 * file focuses on the CLI surface: argv parsing, file I/O, exit codes,
 * stderr messaging, and dry-run semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/index.ts";
import { captureIo } from "./helpers.ts";
import { unzipArtifact } from "@appstrate/core/zip";

const DEC = new TextDecoder();

function authorManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/gmail",
    version: "1.0.0",
    displayName: "Gmail",
    server: { type: "node", entryPoint: "./server/index.js" },
    ...overrides,
  };
}

async function writeManifest(dir: string, m: Record<string, unknown>): Promise<string> {
  const p = join(dir, "manifest.json");
  await writeFile(p, JSON.stringify(m, null, 2));
  return p;
}

describe("afps bundle — CLI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-bundle-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("prints help and exits 0 on --help", async () => {
    const io = captureIo();
    const code = await runCli(["bundle", "--help"], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("afps bundle");
    expect(io.stdoutText()).toContain("--server-dir");
  });

  it("fails with usage when called without input", async () => {
    const io = captureIo();
    const code = await runCli(["bundle"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("missing <manifest.json>");
  });

  it("rejects malformed manifest paths with a friendly error", async () => {
    const io = captureIo();
    const code = await runCli(["bundle", join(dir, "nope.json")], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("failed to read");
  });

  it("bundles a self-contained node manifest with --server-dir", async () => {
    const manifestPath = await writeManifest(dir, authorManifest());
    const serverDir = join(dir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "index.js"), "console.log('mcp');\n");
    const out = join(dir, "out.afps");

    const io = captureIo();
    const code = await runCli(["bundle", manifestPath, "-s", serverDir, "-o", out], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("wrote out.afps");

    const bytes = new Uint8Array(await readFile(out));
    const tree = unzipArtifact(bytes);
    expect(tree["manifest.json"]).toBeDefined();
    expect(tree["server/index.js"]).toBeDefined();
    expect(DEC.decode(tree["server/index.js"]!)).toContain("mcp");
    const distributed = JSON.parse(DEC.decode(tree["manifest.json"]!)) as Record<string, unknown>;
    expect((distributed.server as Record<string, unknown>).type).toBe("node");
  });

  it("includes --doc as INTEGRATION.md", async () => {
    const manifestPath = await writeManifest(dir, authorManifest());
    const docPath = join(dir, "doc.md");
    await writeFile(docPath, "# Gmail integration\n");
    const out = join(dir, "out.afps");

    const serverDir = join(dir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "index.js"), "/* x */\n");

    const io = captureIo();
    const code = await runCli(
      ["bundle", manifestPath, "-s", serverDir, "-d", docPath, "-o", out],
      io,
    );
    expect(code).toBe(0);

    const tree = unzipArtifact(new Uint8Array(await readFile(out)));
    expect(tree["INTEGRATION.md"]).toBeDefined();
    expect(DEC.decode(tree["INTEGRATION.md"]!)).toContain("Gmail");
  });

  it("dry-run does not write the output file", async () => {
    const manifestPath = await writeManifest(dir, authorManifest());
    const serverDir = join(dir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "index.js"), "/* x */\n");
    const out = join(dir, "out.afps");

    const io = captureIo();
    const code = await runCli(
      ["bundle", manifestPath, "-s", serverDir, "-o", out, "--dry-run"],
      io,
    );
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("would write");
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--print-manifest emits the rewritten manifest to stdout", async () => {
    const manifestPath = await writeManifest(dir, authorManifest());
    const serverDir = join(dir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "index.js"), "/* x */\n");

    const io = captureIo();
    const code = await runCli(
      ["bundle", manifestPath, "-s", serverDir, "--dry-run", "--print-manifest"],
      io,
    );
    expect(code).toBe(0);
    const out = io.stdoutText();
    expect(out).toContain('"type": "integration"');
    expect(out).toContain('"@official/gmail"');
  });

  it("rejects a structurally invalid manifest with exit 1", async () => {
    const manifestPath = await writeManifest(dir, {
      type: "integration",
      name: "broken",
    });
    const io = captureIo();
    const code = await runCli(["bundle", manifestPath], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("manifest");
  });

  it("uses the suggestedFileName when --output is omitted", async () => {
    const manifestPath = await writeManifest(dir, authorManifest());
    const serverDir = join(dir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, "index.js"), "/* x */\n");
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const io = captureIo();
      const code = await runCli(["bundle", manifestPath, "-s", serverDir], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("official__gmail@1.0.0.afps");
      await stat(join(dir, "official__gmail@1.0.0.afps"));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("afps bundle — CLI dispatch", () => {
  it("is listed in the top-level help", async () => {
    const io = captureIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("bundle <manifest>");
  });
});
