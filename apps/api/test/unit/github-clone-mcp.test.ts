// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the @appstrate/github-clone-mcp single-tool server.
 *
 * The server is dependency-free (a hand-rolled stdio JSON-RPC loop +
 * a tiny POSIX tar parser), so the tests run pure Bun without spawning
 * a subprocess or touching Docker. We exercise:
 *
 *   - `parseTar` against a hand-built mini tarball (regular files
 *     under a top-level prefix, GNU LongLink for deep paths, mixed
 *     typeflags that must be skipped).
 *   - `detectTopLevelPrefix` for the GitHub `<owner>-<repo>-<sha>/`
 *     wrapper detection — including the negative case (no shared
 *     prefix → null).
 *   - `resolveDest` for the path-traversal floor.
 *   - `handleRequest` for the JSON-RPC surface (initialize / tools/list
 *     / tools/call happy path + error cases).
 *   - `cloneRepo` with a stubbed `fetch` returning a gzipped tarball,
 *     end-to-end into a temp workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseTar,
  detectTopLevelPrefix,
  resolveDest,
  handleRequest,
  cloneRepo,
} from "../../../../scripts/system-packages/mcp-server-github-clone-1.0.0/server/index.ts";

// ─────────────────────────── Tar helpers ────────────────────────────

/**
 * Build a minimal POSIX-tar entry buffer. Real tarballs are far
 * richer (ustar checksum, magic, version) but the parser only reads
 * name, size, typeflag, prefix — so the harness builds the tiniest
 * possible bytes that round-trip through the parser.
 */
function buildTarEntry(name: string, content: Buffer, typeflag = "0"): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  // size — 11-digit octal + space terminator (POSIX convention).
  const sizeStr = content.byteLength.toString(8).padStart(11, "0") + " ";
  header.write(sizeStr, 124, 12, "ascii");
  header.write(typeflag, 156, 1, "ascii");
  const padded = Math.ceil(content.byteLength / 512) * 512;
  const data = Buffer.concat([content, Buffer.alloc(padded - content.byteLength)]);
  return Buffer.concat([header, data]);
}

function buildTar(entries: Array<{ name: string; content: Buffer; typeflag?: string }>): Buffer {
  const chunks = entries.map((e) => buildTarEntry(e.name, e.content, e.typeflag));
  // Two zero blocks mark end-of-archive (POSIX).
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

// ─────────────────────────── parseTar ───────────────────────────────

describe("parseTar", () => {
  it("parses regular files and ignores directories", () => {
    const tar = buildTar([
      { name: "prefix/", content: Buffer.from(""), typeflag: "5" },
      { name: "prefix/README.md", content: Buffer.from("hello") },
      { name: "prefix/src/index.ts", content: Buffer.from("export const x = 1") },
    ]);
    const out = parseTar(tar);
    expect(out).toHaveLength(2);
    expect(out[0]?.name).toBe("prefix/README.md");
    expect(out[0]?.content.toString()).toBe("hello");
    expect(out[1]?.name).toBe("prefix/src/index.ts");
  });

  it("skips symlinks (typeflag 2), hardlinks (1), and global headers (g)", () => {
    const tar = buildTar([
      { name: "prefix/file.txt", content: Buffer.from("real") },
      { name: "prefix/symlink", content: Buffer.from(""), typeflag: "2" },
      { name: "prefix/hardlink", content: Buffer.from(""), typeflag: "1" },
      { name: "prefix/global", content: Buffer.from("ignored"), typeflag: "g" },
    ]);
    const out = parseTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("prefix/file.txt");
  });

  it("honours GNU LongLink (typeflag L) for paths > 100 chars", () => {
    const longName =
      "prefix/very/deeply/nested/directory/structure/that/exceeds/the/posix/tar/name/limit/of/one/hundred/characters/file.txt";
    const tar = buildTar([
      { name: "././@LongLink", content: Buffer.from(longName + "\0"), typeflag: "L" },
      // The header name is truncated; LongLink supplies the real name.
      { name: "TRUNCATED_PLACEHOLDER", content: Buffer.from("deep") },
    ]);
    const out = parseTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe(longName);
    expect(out[0]?.content.toString()).toBe("deep");
  });

  it("throws on a truncated entry (declared size exceeds remaining bytes)", () => {
    const header = Buffer.alloc(512, 0);
    header.write("oversized.txt", 0, 100, "utf8");
    header.write("00000000010 ", 124, 12, "ascii"); // 8 bytes declared
    header.write("0", 156, 1, "ascii");
    // Provide ZERO bytes of payload, then two zero terminator blocks.
    const truncated = Buffer.concat([header, Buffer.alloc(0)]);
    expect(() => parseTar(truncated)).toThrow(/truncated/);
  });

  it("terminates on a zero block (end-of-archive)", () => {
    const tar = buildTar([{ name: "a", content: Buffer.from("x") }]);
    const out = parseTar(tar);
    expect(out).toHaveLength(1);
  });
});

// ──────────────────── detectTopLevelPrefix ──────────────────────────

describe("detectTopLevelPrefix", () => {
  it("detects the prefix when every entry shares the same first segment", () => {
    const prefix = detectTopLevelPrefix([
      { name: "owner-repo-abc/README.md" },
      { name: "owner-repo-abc/src/index.ts" },
      { name: "owner-repo-abc/package.json" },
    ]);
    expect(prefix).toBe("owner-repo-abc");
  });

  it("returns null when entries have heterogeneous first segments", () => {
    const prefix = detectTopLevelPrefix([{ name: "a/file" }, { name: "b/file" }]);
    expect(prefix).toBeNull();
  });

  it("returns null on an empty list", () => {
    expect(detectTopLevelPrefix([])).toBeNull();
  });
});

// ───────────────────────── resolveDest ───────────────────────────────

describe("resolveDest", () => {
  it("resolves a relative dest under the workspace root", () => {
    const root = "/tmp/workspace";
    expect(resolveDest(root, "repo")).toBe("/tmp/workspace/repo");
    expect(resolveDest(root, undefined)).toBe(root);
    expect(resolveDest(root, "")).toBe(root);
  });

  it("strips a leading slash from dest (it's workspace-relative, not absolute)", () => {
    expect(resolveDest("/tmp/workspace", "/repo")).toBe("/tmp/workspace/repo");
  });

  it("rejects a dest containing `..` segments", () => {
    expect(() => resolveDest("/tmp/workspace", "../escape")).toThrow(/path-traversal/);
    expect(() => resolveDest("/tmp/workspace", "ok/../etc")).toThrow(/path-traversal/);
  });
});

// ─────────────────────── handleRequest ──────────────────────────────

describe("handleRequest — JSON-RPC surface", () => {
  it("responds to initialize with protocol version + tools capability", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.id).toBe(1);
    const result = res?.result as { protocolVersion: string; capabilities: { tools: object } };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities.tools).toEqual({});
  });

  it("responds to tools/list with the single clone_repo tool", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = res?.result as { tools: Array<{ name: string; description: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("clone_repo");
  });

  it("returns an MCP error response for an unknown tool name", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bogus" },
    });
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool/);
  });

  it("rejects tools/call with missing owner/repo arguments", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "clone_repo", arguments: { owner: "x" } },
    });
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/owner and repo/);
  });

  it("returns a -32601 error for an unknown method", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 5, method: "unknown/method" });
    expect(res?.error?.code).toBe(-32601);
  });

  it("returns null (no response) for a notification (id absent)", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", method: "notifications/something" });
    expect(res).toBeNull();
  });
});

// ────────────────────────── cloneRepo ────────────────────────────────

describe("cloneRepo — end-to-end with stubbed fetch", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ghclone-test-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  function makeStubFetch(tarballGz: Buffer, status = 200): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("api.github.com/repos/");
      // Sanity check: bearer token is attached.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      return new Response(tarballGz, { status, statusText: status === 200 ? "OK" : "Error" });
    }) as typeof fetch;
  }

  it("downloads, strips the GitHub top-level prefix, and writes files to disk", async () => {
    const tar = buildTar([
      { name: "octo-hello-abc/README.md", content: Buffer.from("# hello") },
      { name: "octo-hello-abc/src/index.ts", content: Buffer.from("export {}") },
    ]);
    const stub = makeStubFetch(Buffer.from(gzipSync(tar)));

    const receipt = await cloneRepo(
      { owner: "octo", repo: "hello", dest: "repo" },
      { fetchImpl: stub, env: { APPSTRATE_WORKSPACE: workspace, GITHUB_TOKEN: "t" } },
    );

    expect(receipt.files).toBe(2);
    expect(receipt.topLevelPrefix).toBe("octo-hello-abc");
    expect(receipt.path).toBe(join(workspace, "repo"));

    const readme = await readFile(join(workspace, "repo", "README.md"), "utf8");
    expect(readme).toBe("# hello");
    const idx = await readFile(join(workspace, "repo", "src", "index.ts"), "utf8");
    expect(idx).toBe("export {}");
  });

  it("throws when APPSTRATE_WORKSPACE is absent", async () => {
    const tar = Buffer.from(gzipSync(buildTar([{ name: "x", content: Buffer.from("") }])));
    await expect(
      cloneRepo(
        { owner: "o", repo: "r" },
        { fetchImpl: makeStubFetch(tar), env: { GITHUB_TOKEN: "t" } },
      ),
    ).rejects.toThrow(/APPSTRATE_WORKSPACE/);
  });

  it("throws when GITHUB_TOKEN is absent", async () => {
    const tar = Buffer.from(gzipSync(buildTar([{ name: "x", content: Buffer.from("") }])));
    await expect(
      cloneRepo(
        { owner: "o", repo: "r" },
        { fetchImpl: makeStubFetch(tar), env: { APPSTRATE_WORKSPACE: workspace } },
      ),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("surfaces a 401 from GitHub with the upstream status in the message", async () => {
    const stub = makeStubFetch(Buffer.from("bad credentials"), 401);
    await expect(
      cloneRepo(
        { owner: "o", repo: "r" },
        { fetchImpl: stub, env: { APPSTRATE_WORKSPACE: workspace, GITHUB_TOKEN: "t" } },
      ),
    ).rejects.toThrow(/401/);
  });

  it("enforces GITHUB_CLONE_MAX_BYTES — fails fast on oversized tarballs", async () => {
    // The gzip check is on the COMPRESSED tarball size — incompressible
    // random bytes survive gzip largely intact, so we use them to make
    // the size predictable and well above the cap.
    const big = Buffer.alloc(2048);
    for (let i = 0; i < big.length; i++) big[i] = Math.floor(Math.random() * 256);
    const gz = Buffer.from(gzipSync(big));
    expect(gz.byteLength).toBeGreaterThan(100); // sanity: > cap
    await expect(
      cloneRepo(
        { owner: "o", repo: "r" },
        {
          fetchImpl: makeStubFetch(gz),
          env: {
            APPSTRATE_WORKSPACE: workspace,
            GITHUB_TOKEN: "t",
            GITHUB_CLONE_MAX_BYTES: "100",
          },
        },
      ),
    ).rejects.toThrow(/MAX_BYTES/);
  });

  it("creates the destination directory when it doesn't already exist", async () => {
    const tar = buildTar([{ name: "p/a.txt", content: Buffer.from("a") }]);
    const stub = makeStubFetch(Buffer.from(gzipSync(tar)));
    await cloneRepo(
      { owner: "o", repo: "r", dest: "nested/dir" },
      { fetchImpl: stub, env: { APPSTRATE_WORKSPACE: workspace, GITHUB_TOKEN: "t" } },
    );
    const st = await stat(join(workspace, "nested", "dir", "a.txt"));
    expect(st.isFile()).toBe(true);
  });
});
