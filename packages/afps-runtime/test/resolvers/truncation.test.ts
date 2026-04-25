// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for truncation metadata propagation:
 *   - X-Truncated / X-Truncated-Size headers → body.truncated / body.truncatedSize
 *   - text, inline, and file (toFile) variants
 *   - defaultInlineLimit matches sidecar MAX_RESPONSE_SIZE (256 KB)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../../src/bundle/index.ts";
import {
  SidecarProviderResolver,
  defaultInlineLimit,
  type ProviderCallResponseBody,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** Deterministic pseudo-random buffer using Mulberry32 PRNG. */
function deterministicBytes(size: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

// ─── Bundle helpers ───────────────────────────────────────────────────────────

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "provider",
  files: Record<string, string>,
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) filesMap.set(k, enc.encode(v));
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

function makeBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

function makeCtx(workspace: string, toolCallId = "tc_test"): ToolContext {
  return {
    workspace,
    toolCallId,
    runId: "run_test",
    signal: new AbortController().signal,
    emit: (_e: RunEvent) => {},
  };
}

// ─── Resolver helper ──────────────────────────────────────────────────────────

function buildSidecarResolver(responder: (url: string, init: RequestInit) => Promise<Response>): {
  execute: (
    params: Parameters<
      Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
    >[0],
    ctx: ToolContext,
  ) => Promise<unknown>;
} {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  const bundle = makeBundle(root, [providerPkg]);

  const fetchImpl = ((url: string, init?: RequestInit) =>
    responder(url, init ?? {})) as typeof fetch;

  const resolver = new SidecarProviderResolver({
    sidecarUrl: "http://sidecar:8080",
    fetch: fetchImpl,
  });

  let executor:
    | Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
    | undefined;
  const ready = (async () => {
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
    executor = tools[0]!.execute;
  })();

  return {
    async execute(params, ctx) {
      await ready;
      return executor!(params, ctx);
    },
  };
}

function parseBody(result: unknown): {
  status: number;
  headers: Record<string, string>;
  body: ProviderCallResponseBody;
} {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("truncation metadata propagation", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-truncation-"));
  });

  afterAll(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── defaultInlineLimit constant ───────────────────────────────────────

  it("defaultInlineLimit is 256 KB (matches sidecar MAX_RESPONSE_SIZE)", () => {
    expect(defaultInlineLimit).toBe(256 * 1024);
  });

  // ─── text variant ──────────────────────────────────────────────────────

  it("text response with X-Truncated=true carries truncated:true and truncatedSize", async () => {
    const cap = 256 * 1024;
    const truncatedText = "a".repeat(cap); // the slice the sidecar kept

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(truncatedText, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "X-Truncated": "true",
            "X-Truncated-Size": String(cap),
          },
        }),
    );

    const res = await execute(
      { method: "GET", target: "https://api.example.com/v1/large-text" },
      makeCtx(workspace, "tc_trunc_text"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("text");
    if (parsed.body.kind !== "text") throw new Error("unreachable");
    expect(parsed.body.truncated).toBe(true); // truncated: true is emitted
    expect(parsed.body.truncatedSize).toBe(cap);
  });

  it("text response without X-Truncated carries truncated:false and no truncatedSize", async () => {
    const text = "a".repeat(100 * 1024); // 100 KB — below default cap

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(text, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );

    const res = await execute(
      { method: "GET", target: "https://api.example.com/v1/small-text" },
      makeCtx(workspace, "tc_notrunc_text"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("text");
    if (parsed.body.kind !== "text") throw new Error("unreachable");
    // When not truncated, `truncated` field is omitted (absence means false).
    expect(parsed.body.truncated).toBeUndefined();
    expect(parsed.body.truncatedSize).toBeUndefined();
  });

  // ─── inline binary variant ─────────────────────────────────────────────

  it("inline binary response with X-Truncated=true carries truncated:true and truncatedSize", async () => {
    const cap = 256 * 1024;
    const truncatedBytes = deterministicBytes(cap, 0xdeadbeef);

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(truncatedBytes, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "X-Truncated": "true",
            "X-Truncated-Size": String(cap),
          },
        }),
    );

    const res = await execute(
      { method: "GET", target: "https://api.example.com/v1/large-bin" },
      makeCtx(workspace, "tc_trunc_inline"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.truncated).toBe(true); // truncated: true is emitted
    expect(parsed.body.truncatedSize).toBe(cap);
    expect(parsed.body.encoding).toBe("base64");
  });

  // ─── AP-4: malformed X-Truncated-Size ──────────────────────────────────

  it("malformed X-Truncated-Size (non-numeric) → truncated:true but truncatedSize is undefined", async () => {
    const cap = 256 * 1024;
    const truncatedText = "b".repeat(cap);

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(truncatedText, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "X-Truncated": "true",
            "X-Truncated-Size": "abc", // malformed — not a valid integer
          },
        }),
    );

    const res = await execute(
      { method: "GET", target: "https://api.example.com/v1/malformed-size" },
      makeCtx(workspace, "tc_trunc_nan"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("text");
    if (parsed.body.kind !== "text") throw new Error("unreachable");
    // truncated is still true (the header was present), but truncatedSize is
    // dropped because parseInt("abc", 10) = NaN which is not finite.
    expect(parsed.body.truncated).toBe(true);
    expect(parsed.body.truncatedSize).toBeUndefined();
  });

  it("valid X-Truncated-Size → numeric value preserved", async () => {
    const cap = 100 * 1024;
    const truncatedText = "c".repeat(cap);

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(truncatedText, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "X-Truncated": "true",
            "X-Truncated-Size": String(cap),
          },
        }),
    );

    const res = await execute(
      { method: "GET", target: "https://api.example.com/v1/valid-size" },
      makeCtx(workspace, "tc_trunc_valid"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("text");
    if (parsed.body.kind !== "text") throw new Error("unreachable");
    expect(parsed.body.truncated).toBe(true);
    expect(parsed.body.truncatedSize).toBe(cap);
  });

  // ─── file (toFile) variant — never truncated ───────────────────────────

  it("responseMode.toFile body has no truncated field (file variant not truncated)", async () => {
    const bytes = deterministicBytes(50 * 1024, 0x1234);

    const { execute } = buildSidecarResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const res = await execute(
      {
        method: "GET",
        target: "https://api.example.com/v1/doc",
        responseMode: { toFile: "downloads/result.bin" },
      },
      makeCtx(workspace, "tc_trunc_tofile"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("file");
    if (parsed.body.kind !== "file") throw new Error("unreachable");
    // file variant has no truncated field in its type
    expect((parsed.body as Record<string, unknown>)["truncated"]).toBeUndefined();
    expect(parsed.body.size).toBe(bytes.byteLength);
  });
});
