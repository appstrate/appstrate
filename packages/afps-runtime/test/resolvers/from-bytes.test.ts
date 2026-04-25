// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Comprehensive test suite for the `{ fromBytes, encoding: "base64" }` body
 * variant introduced in Phase 2 of the binary-passthrough corrective plan.
 *
 * Tests both `resolveBodyStream` and `resolveBodyForFetch` directly, as well
 * as the end-to-end path through `SidecarProviderResolver` to verify that the
 * body reaches the upstream byte-perfectly.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBodyStream,
  resolveBodyForFetch,
  MAX_REQUEST_BODY_SIZE,
} from "../../src/resolvers/provider-tool.ts";
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
  type ProviderCallResponseBody,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Deterministic pseudo-random buffer using Mulberry32. */
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

// ─── Bundle helpers ────────────────────────────────────────────────────────

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

interface Captured {
  url: string;
  init: RequestInit;
  bodyBytes: Uint8Array | undefined;
}

function makeFetchCapture(
  responder: (req: { url: string; init: RequestInit }) => Promise<Response>,
): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const captured: Captured = { url: String(url), init: init ?? {}, bodyBytes: undefined };
    if (init?.body) {
      if (init.body instanceof Uint8Array) {
        captured.bodyBytes = new Uint8Array(init.body);
      } else if (typeof init.body === "string") {
        captured.bodyBytes = enc.encode(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        captured.bodyBytes = new Uint8Array(init.body);
      }
    }
    calls.push(captured);
    return responder({ url: captured.url, init: captured.init });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function buildSidecarResolver(
  responder: (req: { url: string; init: RequestInit }) => Promise<Response>,
): {
  execute: (
    params: Parameters<
      Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
    >[0],
    ctx: ToolContext,
  ) => Promise<unknown>;
  calls: Captured[];
} {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  const bundle = makeBundle(root, [providerPkg]);

  const { calls, fetchImpl } = makeFetchCapture(responder);
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
    calls,
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

// ─── Suite ─────────────────────────────────────────────────────────────────

describe("fromBytes body variant", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-frombytes-"));
  });

  afterAll(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── resolveBodyStream ──────────────────────────────────────────────────

  describe("resolveBodyStream", () => {
    it("1 KB roundtrip — decoded bytes match sha256", async () => {
      const original = deterministicBytes(1024, 0xabc);
      const b64 = toBase64(original);
      const result = await resolveBodyStream({ fromBytes: b64, encoding: "base64" });
      expect(result).toBeInstanceOf(Uint8Array);
      const decoded = result as Uint8Array;
      expect(decoded.byteLength).toBe(original.byteLength);
      expect(sha256(decoded)).toBe(sha256(original));
    });

    it("1 MB roundtrip — decoded bytes match sha256", async () => {
      const original = deterministicBytes(1 * 1024 * 1024, 0xdeadbeef);
      const b64 = toBase64(original);
      const result = await resolveBodyStream({ fromBytes: b64, encoding: "base64" });
      expect(result).toBeInstanceOf(Uint8Array);
      const decoded = result as Uint8Array;
      expect(sha256(decoded)).toBe(sha256(original));
    });

    it("5 MB exact (MAX_REQUEST_BODY_SIZE) — accepted", async () => {
      const original = deterministicBytes(MAX_REQUEST_BODY_SIZE, 0x1234);
      const b64 = toBase64(original);
      const result = await resolveBodyStream({ fromBytes: b64, encoding: "base64" });
      expect(result).toBeInstanceOf(Uint8Array);
      expect((result as Uint8Array).byteLength).toBe(MAX_REQUEST_BODY_SIZE);
    });

    it("5 MB + 1 byte — throws RESOLVER_BODY_TOO_LARGE", async () => {
      const original = deterministicBytes(MAX_REQUEST_BODY_SIZE + 1, 0x5678);
      const b64 = toBase64(original);
      try {
        await resolveBodyStream({ fromBytes: b64, encoding: "base64" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_TOO_LARGE");
      }
    });

    it("invalid base64 ('!!!') — throws RESOLVER_BODY_INVALID", async () => {
      try {
        await resolveBodyStream({ fromBytes: "!!!", encoding: "base64" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_INVALID");
      }
    });

    it("wrong encoding ('hex') — throws RESOLVER_BODY_INVALID", async () => {
      try {
        await resolveBodyStream({ fromBytes: "deadbeef", encoding: "hex" as any });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_INVALID");
      }
    });

    it("empty fromBytes string — produces 0 bytes", async () => {
      const result = await resolveBodyStream({ fromBytes: "", encoding: "base64" });
      expect(result).toBeInstanceOf(Uint8Array);
      expect((result as Uint8Array).byteLength).toBe(0);
    });
  });

  // ─── resolveBodyForFetch ────────────────────────────────────────────────

  describe("resolveBodyForFetch", () => {
    it("1 KB roundtrip — returns { kind: 'bytes' } with exact decoded bytes", async () => {
      const original = deterministicBytes(1024, 0xfeedface);
      const b64 = toBase64(original);
      const result = await resolveBodyForFetch({ fromBytes: b64, encoding: "base64" });
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");
      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(sha256(result.bytes as Uint8Array)).toBe(sha256(original));
    });

    it("5 MB + 1 byte — throws RESOLVER_BODY_TOO_LARGE", async () => {
      const original = deterministicBytes(MAX_REQUEST_BODY_SIZE + 1, 0x9abc);
      const b64 = toBase64(original);
      try {
        await resolveBodyForFetch({ fromBytes: b64, encoding: "base64" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_TOO_LARGE");
      }
    });

    it("invalid base64 — throws RESOLVER_BODY_INVALID", async () => {
      try {
        await resolveBodyForFetch({ fromBytes: "!!invalid!!", encoding: "base64" });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_INVALID");
      }
    });

    it("wrong encoding — throws RESOLVER_BODY_INVALID", async () => {
      try {
        await resolveBodyForFetch({ fromBytes: "aGVsbG8=", encoding: "hex" as any });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_INVALID");
      }
    });
  });

  // ─── End-to-end via SidecarProviderResolver ─────────────────────────────

  describe("end-to-end via SidecarProviderResolver", () => {
    it("1 KB fromBytes — upstream receives exact bytes, sha256 matches", async () => {
      const original = deterministicBytes(1024, 0x111);
      const expectedSha = sha256(original);
      const b64 = toBase64(original);

      const { calls, execute } = buildSidecarResolver(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      await execute(
        {
          method: "POST",
          target: "https://upload.example.com/v1/binary",
          body: { fromBytes: b64, encoding: "base64" },
        },
        makeCtx(workspace, "tc_frombytes_1k"),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.bodyBytes).toBeDefined();
      expect(calls[0]!.bodyBytes!.byteLength).toBe(original.byteLength);
      expect(sha256(calls[0]!.bodyBytes!)).toBe(expectedSha);
    });

    it("1 MB fromBytes — upstream receives exact bytes", async () => {
      const original = deterministicBytes(1 * 1024 * 1024, 0x222);
      const expectedSha = sha256(original);
      const b64 = toBase64(original);

      const { calls, execute } = buildSidecarResolver(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
      await execute(
        {
          method: "POST",
          target: "https://upload.example.com/v1/binary",
          body: { fromBytes: b64, encoding: "base64" },
        },
        makeCtx(workspace, "tc_frombytes_1mb"),
      );

      expect(calls).toHaveLength(1);
      expect(sha256(calls[0]!.bodyBytes!)).toBe(expectedSha);
    });

    it("fromBytes response — tool result includes upstream status", async () => {
      const original = deterministicBytes(16, 0x333);
      const b64 = toBase64(original);

      const { execute } = buildSidecarResolver(
        async () =>
          new Response(JSON.stringify({ created: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const res = await execute(
        {
          method: "PUT",
          target: "https://api.example.com/resource",
          body: { fromBytes: b64, encoding: "base64" },
        },
        makeCtx(workspace, "tc_frombytes_status"),
      );
      const parsed = parseBody(res);
      expect(parsed.status).toBe(201);
      expect(parsed.body.kind).toBe("text");
    });
  });

  // ─── JSON schema validation ──────────────────────────────────────────────

  describe("JSON schema shape — fromBytes requires encoding field", () => {
    it("schema oneOf entry requires both fromBytes and encoding", () => {
      // Validate that the schema in the tool parameters correctly encodes
      // the constraint. We inspect the schema object directly rather than
      // running AJV, matching the existing test-file style.
      const { makeProviderTool } =
        require("../../src/resolvers/provider-tool.ts") as typeof import("../../src/resolvers/provider-tool.ts");
      const tool = makeProviderTool(
        { name: "@acme/test-provider", allowAllUris: true },
        async () => {
          throw new Error("not called");
        },
      );

      // Zod 4 generates anyOf for unions (both oneOf and anyOf are semantically
      // equivalent for discriminated unions; LLMs consume either form).
      const bodySchema = (
        tool.parameters as { properties: { body: { anyOf?: unknown[]; oneOf?: unknown[] } } }
      ).properties.body;
      const variants = bodySchema.anyOf ?? bodySchema.oneOf ?? [];

      // Should have 5 variants: string, fromFile object, fromBytes object, multipart object, null
      expect(variants.length).toBe(5);

      const fromBytesVariant = variants.find(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          "required" in v &&
          Array.isArray((v as { required: string[] }).required) &&
          (v as { required: string[] }).required.includes("fromBytes"),
      ) as
        | { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
        | undefined;

      expect(fromBytesVariant).toBeDefined();
      expect(fromBytesVariant!.required).toContain("encoding");
      expect(fromBytesVariant!.additionalProperties).toBe(false);
    });
  });
});
