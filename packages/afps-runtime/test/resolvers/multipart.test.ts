// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for the { multipart: [...] } body variant.
 *
 * Covers resolveBodyForFetch + resolveBodyStream directly, and end-to-end
 * through SidecarProviderResolver using an Bun.serve mock that captures the
 * upstream multipart request body.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBodyForFetch,
  resolveBodyStream,
  makeProviderTool,
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

// ─── Bundle helpers (mirrors from-bytes.test.ts) ───────────────────────────

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

/**
 * Binary multipart/form-data parser. Operates entirely in byte space so
 * binary part bodies are preserved exactly (no UTF-8 re-encoding corruption).
 */
function parseMultipart(
  bytes: Uint8Array,
  contentType: string,
): Map<
  string,
  { disposition: Record<string, string>; contentType: string | null; body: Uint8Array }
> {
  const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/);
  if (!boundaryMatch) throw new Error(`No boundary in Content-Type: ${contentType}`);
  const boundary = boundaryMatch[2]!;

  const delimBytes = enc.encode(`--${boundary}`);
  const crlfCrlfBytes = enc.encode("\r\n\r\n");

  const result = new Map<
    string,
    { disposition: Record<string, string>; contentType: string | null; body: Uint8Array }
  >();

  // Find all occurrences of the delimiter in the byte array
  function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
    outer: for (let i = from; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  let pos = indexOf(bytes, delimBytes, 0);
  if (pos === -1) return result;

  while (true) {
    // After delimiter, expect CRLF (or "--" for closing)
    let afterDelim = pos + delimBytes.length;
    if (
      afterDelim + 2 <= bytes.length &&
      bytes[afterDelim] === 0x2d &&
      bytes[afterDelim + 1] === 0x2d
    ) {
      // Closing delimiter "--boundary--"
      break;
    }
    // Skip CRLF
    if (bytes[afterDelim] === 0x0d && bytes[afterDelim + 1] === 0x0a) afterDelim += 2;

    // Find the header/body separator: CRLFCRLF
    const hdrsEnd = indexOf(bytes, crlfCrlfBytes, afterDelim);
    if (hdrsEnd === -1) break;

    const headersText = new TextDecoder().decode(bytes.slice(afterDelim, hdrsEnd));
    const bodyStart = hdrsEnd + 4; // skip CRLFCRLF

    // Find next delimiter (preceded by CRLF)
    const nextDelim = indexOf(bytes, delimBytes, bodyStart);
    if (nextDelim === -1) break;

    // Body ends right before the CRLF that precedes the next delimiter
    const bodyEnd =
      nextDelim >= 2 && bytes[nextDelim - 2] === 0x0d && bytes[nextDelim - 1] === 0x0a
        ? nextDelim - 2
        : nextDelim;

    const bodyBytes = bytes.slice(bodyStart, bodyEnd);

    // Parse headers
    const headers: Record<string, string> = {};
    for (const line of headersText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    const cd = headers["content-disposition"] ?? "";
    const disposition: Record<string, string> = {};
    for (const m of cd.matchAll(/(\w+)="([^"]*)"/g)) {
      disposition[m[1]!] = m[2]!;
    }
    const name = disposition["name"];
    if (name) {
      result.set(name, {
        disposition,
        contentType: headers["content-type"] ?? null,
        body: bodyBytes,
      });
    }

    pos = nextDelim;
  }

  return result;
}

// ─── E2E helper using SidecarProviderResolver ──────────────────────────────

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  bodyBytes: Uint8Array;
  contentType: string | null;
}

function buildSidecarResolver(responder: (cap: CapturedRequest) => Promise<Response>): {
  execute: (
    params: Parameters<
      Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
    >[0],
    ctx: ToolContext,
  ) => Promise<unknown>;
  captures: CapturedRequest[];
} {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  const bundle = makeBundle(root, [providerPkg]);

  const captures: CapturedRequest[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const bodyArrayBuffer =
      init?.body instanceof Uint8Array
        ? (init.body as Uint8Array).buffer
        : init?.body instanceof ArrayBuffer
          ? init.body
          : init?.body && typeof (init.body as ReadableStream).getReader === "function"
            ? await new Response(init.body as ReadableStream).arrayBuffer()
            : init?.body instanceof ReadableStream
              ? await new Response(init.body).arrayBuffer()
              : null;

    const bodyBytes = bodyArrayBuffer
      ? new Uint8Array(bodyArrayBuffer as ArrayBuffer)
      : new Uint8Array(0);
    const hdrs = (init?.headers as Record<string, string>) ?? {};
    const ct = hdrs["Content-Type"] ?? hdrs["content-type"] ?? null;

    const cap: CapturedRequest = {
      url: String(url),
      headers: hdrs,
      bodyBytes,
      contentType: ct,
    };
    captures.push(cap);
    return responder(cap);
  }) as typeof fetch;

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
    captures,
  };
}

function jsonResp(status = 200) {
  return async () =>
    new Response("{}", { status, headers: { "content-type": "application/json" } });
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

describe("multipart body variant", () => {
  let workspace: string;
  let fileA: string;
  let fileB: string;
  const fileBContent = deterministicBytes(512, 0xaabb);

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-multipart-"));
    await mkdir(join(workspace, "documents"), { recursive: true });
    fileA = "documents/hello.txt";
    fileB = "documents/data.bin";
    await writeFile(join(workspace, fileA), "Hello from file A");
    await writeFile(join(workspace, fileB), fileBContent);
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  // ─── resolveBodyForFetch direct tests ──────────────────────────────────

  describe("resolveBodyForFetch", () => {
    it("pure text multipart (2 fields) → returns bytes + content-type with boundary", async () => {
      const result = await resolveBodyForFetch(
        {
          multipart: [
            { name: "field1", value: "alpha" },
            { name: "field2", value: "beta" },
          ],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");
      expect(result.contentType).toBeDefined();
      expect(result.contentType).toMatch(/^multipart\/form-data; boundary=/);

      // Parse and verify parts
      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      expect(parts.has("field1")).toBe(true);
      expect(parts.has("field2")).toBe(true);
      const dec = new TextDecoder();
      expect(dec.decode(parts.get("field1")!.body)).toBe("alpha");
      expect(dec.decode(parts.get("field2")!.body)).toBe("beta");
    });

    it("text + fromFile → mixed multipart, file bytes byte-perfect", async () => {
      const result = await resolveBodyForFetch(
        {
          multipart: [
            { name: "msg", value: "upload" },
            { name: "file", fromFile: fileB },
          ],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");

      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      expect(parts.has("msg")).toBe(true);
      expect(parts.has("file")).toBe(true);
      // The file body bytes must match the original
      const filePart = parts.get("file")!;
      expect(filePart.body).toEqual(fileBContent);
    });

    it("text + fromBytes → mixed multipart, base64 decoded correctly", async () => {
      const bytes = deterministicBytes(64, 0xccdd);
      const b64 = toBase64(bytes);
      const result = await resolveBodyForFetch(
        {
          multipart: [
            { name: "info", value: "test" },
            { name: "data", fromBytes: b64, encoding: "base64" },
          ],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");

      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      expect(parts.has("data")).toBe(true);
      expect(parts.get("data")!.body).toEqual(bytes);
    });

    it("all three types in one body → all parts present", async () => {
      const bytes = deterministicBytes(16, 0x1234);
      const result = await resolveBodyForFetch(
        {
          multipart: [
            { name: "text_field", value: "hello" },
            { name: "file_field", fromFile: fileA },
            { name: "bytes_field", fromBytes: toBase64(bytes), encoding: "base64" },
          ],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");

      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      expect(parts.has("text_field")).toBe(true);
      expect(parts.has("file_field")).toBe(true);
      expect(parts.has("bytes_field")).toBe(true);
    });

    it("contentType override for fromFile → Content-Type header in part", async () => {
      const result = await resolveBodyForFetch(
        {
          multipart: [
            { name: "file", fromFile: fileB, contentType: "image/png", filename: "photo.png" },
          ],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");

      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      const filePart = parts.get("file")!;
      expect(filePart.contentType).toBe("image/png");
      expect(filePart.disposition["filename"]).toBe("photo.png");
    });

    it("custom filename override → disposition carries that filename", async () => {
      const result = await resolveBodyForFetch(
        {
          multipart: [{ name: "upload", fromFile: fileA, filename: "custom-name.txt" }],
        },
        { allowFromFile: true, workspace },
      );
      expect(result.kind).toBe("bytes");
      if (result.kind !== "bytes") throw new Error("unreachable");

      const parts = parseMultipart(result.bytes as Uint8Array, result.contentType!);
      expect(parts.get("upload")!.disposition["filename"]).toBe("custom-name.txt");
    });

    it("symlink in fromFile part → throws RESOLVER_PATH_OUTSIDE_WORKSPACE", async () => {
      const symlinkPath = join(workspace, "documents", "link.txt");
      await symlink("/etc/hosts", symlinkPath).catch(() => {});
      try {
        await resolveBodyForFetch(
          { multipart: [{ name: "f", fromFile: "documents/link.txt" }] },
          { allowFromFile: true, workspace },
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      } finally {
        await rm(symlinkPath, { force: true }).catch(() => {});
      }
    });

    it("path traversal in fromFile part → throws RESOLVER_PATH_OUTSIDE_WORKSPACE", async () => {
      try {
        await resolveBodyForFetch(
          { multipart: [{ name: "f", fromFile: "../etc/passwd" }] },
          { allowFromFile: true, workspace },
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      }
    });

    it("invalid base64 in fromBytes part → throws RESOLVER_BODY_INVALID", async () => {
      try {
        await resolveBodyForFetch(
          { multipart: [{ name: "f", fromBytes: "!!!invalid!!!", encoding: "base64" }] },
          { allowFromFile: true, workspace },
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_INVALID");
      }
    });

    it("empty multipart array → schema minItems:1 enforced via JSON schema shape", () => {
      // Directly verify the schema minItems constraint rather than running AJV
      const tool = makeProviderTool({ name: "@acme/provider", allowAllUris: true }, async () => {
        throw new Error("not called");
      });
      const bodySchema = (
        tool.parameters as {
          properties: {
            body: {
              oneOf: Array<{
                type?: string;
                required?: string[];
                properties?: { multipart?: { minItems?: number } };
              }>;
            };
          };
        }
      ).properties.body;

      const multipartVariant = bodySchema.oneOf.find((v) => v.required?.includes("multipart"));
      expect(multipartVariant).toBeDefined();
      expect(multipartVariant!.properties!.multipart!.minItems).toBe(1);
    });

    it("total size > 5 MB → throws RESOLVER_BODY_TOO_LARGE", async () => {
      // Two parts: fromBytes each approaching 3 MB → total > 5 MB
      const chunk = deterministicBytes(3 * 1024 * 1024, 0xabcd);
      const b64 = toBase64(chunk);
      try {
        await resolveBodyForFetch(
          {
            multipart: [
              { name: "a", fromBytes: b64, encoding: "base64" },
              { name: "b", fromBytes: b64, encoding: "base64" },
            ],
          },
          { allowFromFile: true, workspace },
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_TOO_LARGE");
      }
    });
  });

  // ─── resolveBodyStream direct tests ────────────────────────────────────

  describe("resolveBodyStream", () => {
    it("pure text multipart → returns Uint8Array with valid multipart content", async () => {
      const result = await resolveBodyStream(
        { multipart: [{ name: "x", value: "hello" }] },
        { allowFromFile: true, workspace },
      );
      expect(result).toBeInstanceOf(Uint8Array);
      // Should contain the value
      const text = new TextDecoder().decode(result as Uint8Array);
      expect(text).toContain("hello");
    });

    it("withoutAllowFromFile → throws RESOLVER_BODY_REFERENCE_FORBIDDEN", async () => {
      try {
        await resolveBodyStream(
          { multipart: [{ name: "f", fromFile: fileA }] },
          { allowFromFile: false, workspace },
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_BODY_REFERENCE_FORBIDDEN");
      }
    });
  });

  // ─── Schema shape ───────────────────────────────────────────────────────

  describe("JSON schema", () => {
    it("schema oneOf has 5 variants: string, fromFile, fromBytes, multipart, null", () => {
      const tool = makeProviderTool({ name: "@acme/p", allowAllUris: true }, async () => {
        throw new Error("not called");
      });
      const bodySchema = (tool.parameters as { properties: { body: { oneOf: unknown[] } } })
        .properties.body;
      expect(bodySchema.oneOf.length).toBe(5);
    });

    it("multipart variant requires 'multipart' field with items oneOf[3]", () => {
      const tool = makeProviderTool({ name: "@acme/p", allowAllUris: true }, async () => {
        throw new Error("not called");
      });
      type BodyVariant = {
        required?: string[];
        properties?: {
          multipart?: { type?: string; minItems?: number; items?: { oneOf?: unknown[] } };
        };
      };
      const bodySchema = (tool.parameters as { properties: { body: { oneOf: BodyVariant[] } } })
        .properties.body;
      const mpVariant = bodySchema.oneOf.find((v) => v.required?.includes("multipart"));
      expect(mpVariant).toBeDefined();
      expect(mpVariant!.properties!.multipart!.type).toBe("array");
      expect(mpVariant!.properties!.multipart!.minItems).toBe(1);
      expect(mpVariant!.properties!.multipart!.items!.oneOf!.length).toBe(3);
    });

    it("missing 'name' in multipart part is caught by additionalProperties:false on each part variant", () => {
      // Verify each part variant requires 'name'
      const tool = makeProviderTool({ name: "@acme/p", allowAllUris: true }, async () => {
        throw new Error("not called");
      });
      type BodyVariant = {
        required?: string[];
        properties?: {
          multipart?: {
            items?: {
              oneOf?: Array<{ required?: string[]; additionalProperties?: boolean }>;
            };
          };
        };
      };
      const bodySchema = (tool.parameters as { properties: { body: { oneOf: BodyVariant[] } } })
        .properties.body;
      const mpVariant = bodySchema.oneOf.find((v) => v.required?.includes("multipart"))!;
      const partOneOf = mpVariant.properties!.multipart!.items!.oneOf!;
      for (const partVariant of partOneOf) {
        expect(partVariant.required).toContain("name");
        expect(partVariant.additionalProperties).toBe(false);
      }
    });
  });

  // ─── End-to-end via SidecarProviderResolver ─────────────────────────────

  describe("end-to-end via SidecarProviderResolver", () => {
    it("pure text multipart (2 fields) → upstream receives correct multipart with boundary", async () => {
      const { captures, execute } = buildSidecarResolver(jsonResp());
      await execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "title", value: "Report" },
              { name: "year", value: "2026" },
            ],
          },
        },
        makeCtx(workspace, "tc_mp_text"),
      );
      expect(captures).toHaveLength(1);
      const cap = captures[0]!;
      expect(cap.contentType).toMatch(/^multipart\/form-data; boundary=/);

      const parts = parseMultipart(cap.bodyBytes, cap.contentType!);
      expect(parts.has("title")).toBe(true);
      expect(parts.has("year")).toBe(true);
      expect(new TextDecoder().decode(parts.get("title")!.body)).toBe("Report");
      expect(new TextDecoder().decode(parts.get("year")!.body)).toBe("2026");
    });

    it("text + fromFile → upstream receives mixed multipart, file bytes byte-perfect", async () => {
      const { captures, execute } = buildSidecarResolver(jsonResp());
      await execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "note", value: "data" },
              { name: "file", fromFile: fileB },
            ],
          },
        },
        makeCtx(workspace, "tc_mp_file"),
      );
      expect(captures).toHaveLength(1);
      const cap = captures[0]!;
      const parts = parseMultipart(cap.bodyBytes, cap.contentType!);
      expect(parts.has("file")).toBe(true);
      expect(parts.get("file")!.body).toEqual(fileBContent);
    });

    it("text + fromBytes → mixed multipart, base64 decoded correctly", async () => {
      const bytes = deterministicBytes(128, 0x5678);
      const { captures, execute } = buildSidecarResolver(jsonResp());
      await execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "meta", value: "info" },
              { name: "data", fromBytes: toBase64(bytes), encoding: "base64" },
            ],
          },
        },
        makeCtx(workspace, "tc_mp_frombytes"),
      );
      const cap = captures[0]!;
      const parts = parseMultipart(cap.bodyBytes, cap.contentType!);
      expect(parts.get("data")!.body).toEqual(bytes);
    });

    it("all three types in one body → all parts present, tool result has 200 status", async () => {
      const bytes = deterministicBytes(8, 0x9999);
      const { captures, execute } = buildSidecarResolver(jsonResp(200));
      const result = await execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "text_f", value: "x" },
              { name: "file_f", fromFile: fileA },
              { name: "bytes_f", fromBytes: toBase64(bytes), encoding: "base64" },
            ],
          },
        },
        makeCtx(workspace, "tc_mp_all"),
      );
      const cap = captures[0]!;
      const parts = parseMultipart(cap.bodyBytes, cap.contentType!);
      expect(parts.has("text_f")).toBe(true);
      expect(parts.has("file_f")).toBe(true);
      expect(parts.has("bytes_f")).toBe(true);
      expect(parseBody(result).status).toBe(200);
    });

    it("contentType override: explicit contentType in fromFile part → upstream sees it", async () => {
      const { captures, execute } = buildSidecarResolver(jsonResp());
      await execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "img", fromFile: fileB, contentType: "image/png", filename: "photo.png" },
            ],
          },
        },
        makeCtx(workspace, "tc_mp_ct_override"),
      );
      const cap = captures[0]!;
      const parts = parseMultipart(cap.bodyBytes, cap.contentType!);
      expect(parts.get("img")!.contentType).toBe("image/png");
      expect(parts.get("img")!.disposition["filename"]).toBe("photo.png");
    });
  });
});
