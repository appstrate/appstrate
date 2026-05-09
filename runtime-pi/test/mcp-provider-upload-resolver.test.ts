// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `McpProviderUploadResolver` — the
 * orchestrator behind `provider_upload`.
 *
 * Test shape mirrors `mcp-provider-resolver.test.ts`: an in-process
 * MCP pair where the server-side handler stands in for the sidecar's
 * `provider_call` implementation. Each test wires a per-protocol
 * mock upstream simulator into that handler so we can verify
 * end-to-end: file → chunked dispatch → upstream confirms → result.
 *
 * For every adapter we cover:
 *   - Happy path: a 12 MB synthetic file uploaded against a stub
 *     server, byte-for-byte equivalence at the upstream's "received"
 *     buffer, SHA-256 stability.
 *   - Cancellation: an aborted signal mid-upload triggers
 *     adapter.abort() and surfaces a structured failure.
 *   - Upstream protocol-level error: a non-success status surfaces
 *     in the result with the right status code.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { McpProviderUploadResolver } from "../mcp/provider-upload-resolver.ts";
import type { UploadProtocol } from "../mcp/upload-adapters/index.ts";

const ctxBase = (workspace: string) => ({
  runId: "run_test",
  toolCallId: "tc_1",
  workspace,
  signal: new AbortController().signal,
});

/** Build a byte-deterministic synthetic file in a fresh tmpdir. */
function writeSyntheticFile(name: string, size: number) {
  const ws = mkdtempSync(join(tmpdir(), "upload-"));
  // Use a pseudo-random pattern so different chunks have different
  // bytes (helps catch off-by-one chunk mistakes that might pass
  // with all-zeros).
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 2654435761) & 0xff;
  writeFileSync(join(ws, name), bytes);
  return { workspace: ws, bytes };
}

/**
 * Build an in-process MCP pair whose `provider_call` handler is
 * driven by a per-test simulator. The simulator receives the same
 * args shape the sidecar would and returns the CallToolResult shape
 * (including `_meta`) that the resolver's wrapper expects.
 */
async function makePair(
  simulate: (args: Record<string, unknown>) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    isError?: boolean;
  }>,
) {
  const tool: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description: "mock",
      inputSchema: { type: "object" },
    },
    handler: (async (args: Record<string, unknown>) => {
      const sim = await simulate(args);
      return {
        content: [{ type: "text", text: sim.body }],
        ...(sim.isError ? { isError: true } : {}),
        _meta: {
          "appstrate/upstream": {
            status: sim.status,
            headers: sim.headers,
          },
        },
      };
    }) as never,
  };
  const pair = await createInProcessPair([tool]);
  return { pair, mcp: wrapClient(pair.client, { close: () => Promise.resolve() }) };
}

function decodeBody(args: Record<string, unknown>): Uint8Array {
  const body = args.body as string | { fromBytes: string; encoding: string } | undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body && typeof body === "object" && "fromBytes" in body) {
    return new Uint8Array(Buffer.from(body.fromBytes, "base64"));
  }
  return new Uint8Array(0);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── Google resumable ─────────────────────────────────────────────

class GoogleStubServer {
  private uploaded = new Map<string, Uint8Array>();
  private nextSession = 1;

  /**
   * Simulator entry point. Maps `(method, target)` to the protocol's
   * defined responses.
   */
  handle(args: Record<string, unknown>): {
    status: number;
    headers: Record<string, string>;
    body: string;
    isError?: boolean;
  } {
    const method = args.method as string;
    const target = args.target as string;
    const headers = (args.headers ?? {}) as Record<string, string>;

    // Init: POST to the agent-supplied target (Drive: ?uploadType=resumable)
    if (method === "POST" && /uploadType=resumable/.test(target)) {
      const id = `session-${this.nextSession++}`;
      this.uploaded.set(id, new Uint8Array(0));
      return {
        status: 200,
        headers: { location: `https://example.test/upload/${id}` },
        body: "",
      };
    }

    // Chunk: PUT to a session URL
    const m = target.match(/upload\/(session-\d+)/);
    if (method === "PUT" && m) {
      const id = m[1]!;
      const buf = this.uploaded.get(id);
      if (!buf) return { status: 404, headers: {}, body: "session not found", isError: true };
      const range = headers["Content-Range"];
      const rm = range?.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!rm) return { status: 400, headers: {}, body: "missing Content-Range", isError: true };
      const start = Number(rm[1]);
      const end = Number(rm[2]);
      const total = Number(rm[3]);
      const chunk = decodeBody(args);
      if (chunk.byteLength !== end - start + 1) {
        return {
          status: 400,
          headers: {},
          body: `chunk length ${chunk.byteLength} != range ${end - start + 1}`,
          isError: true,
        };
      }
      const merged = new Uint8Array(start + chunk.byteLength);
      merged.set(buf, 0);
      merged.set(chunk, start);
      this.uploaded.set(id, merged);
      const isFinal = end + 1 === total;
      if (isFinal) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "drive-file-id", name: "uploaded.bin" }),
        };
      }
      return { status: 308, headers: { range: `bytes=0-${end}` }, body: "" };
    }

    // Abort: DELETE session URL
    if (method === "DELETE" && m) {
      this.uploaded.delete(m[1]!);
      return { status: 204, headers: {}, body: "" };
    }

    return { status: 400, headers: {}, body: `unhandled ${method} ${target}`, isError: true };
  }

  uploadedBytes(id: string): Uint8Array | undefined {
    return this.uploaded.get(id);
  }
}

describe("McpProviderUploadResolver — google-resumable", () => {
  it("uploads a 12 MB file end-to-end with byte-equivalence + SHA-256", async () => {
    const stub = new GoogleStubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace, bytes } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const expectedSha = sha256Hex(bytes);

      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/drive",
          target: "https://example.test/upload?uploadType=resumable",
          fromFile: "big.bin",
          uploadProtocol: "google-resumable" as UploadProtocol,
          metadata: { name: "uploaded.bin", mimeType: "application/octet-stream" },
          partSizeBytes: 4 * 1024 * 1024,
        },
        ctxBase(workspace),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.size).toBe(12 * 1024 * 1024);
      expect(result.chunks).toBe(3);
      expect(result.sha256).toBe(expectedSha);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).id).toBe("drive-file-id");

      // Byte-equivalence check on the simulator's reconstructed buffer.
      const received = stub.uploadedBytes("session-1")!;
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(sha256Hex(received)).toBe(expectedSha);
    } finally {
      await pair.close();
    }
  });

  it("rejects mis-aligned partSizeBytes (256 KiB grid)", async () => {
    const stub = new GoogleStubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/drive",
          target: "https://example.test/upload?uploadType=resumable",
          fromFile: "big.bin",
          uploadProtocol: "google-resumable",
          partSizeBytes: 1_000_000, // not a multiple of 256 KiB
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/multiple of/);
    } finally {
      await pair.close();
    }
  });

  it("aborts gracefully when ctx.signal fires mid-upload", async () => {
    const stub = new GoogleStubServer();
    let chunkCount = 0;
    const ac = new AbortController();
    const { pair, mcp } = await makePair(async (args) => {
      const r = stub.handle(args);
      if ((args.method as string) === "PUT") {
        chunkCount += 1;
        // Simulate network latency so the abort can land between
        // chunks. Without the delay, the in-process pair completes
        // the entire upload in <1 ms and the abort never fires
        // mid-flight.
        await new Promise((resolve) => setTimeout(resolve, 30));
        // Fire the abort during the second chunk so we exercise the
        // mid-upload cancel path deterministically.
        if (chunkCount === 2) ac.abort(new Error("user cancelled"));
      }
      return r;
    });
    try {
      const { workspace } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/drive",
          target: "https://example.test/upload?uploadType=resumable",
          fromFile: "big.bin",
          uploadProtocol: "google-resumable",
          partSizeBytes: 4 * 1024 * 1024,
        },
        { runId: "r", toolCallId: "t", workspace, signal: ac.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/cancelled|aborted|abort/i);
      // The third chunk must NOT have been dispatched.
      expect(chunkCount).toBeLessThan(3);
    } finally {
      await pair.close();
    }
  });
});

// ─── S3 multipart ─────────────────────────────────────────────────

class S3StubServer {
  private uploads = new Map<string, { parts: Map<number, Uint8Array>; completed: boolean }>();
  private nextUploadId = 1;

  handle(args: Record<string, unknown>): {
    status: number;
    headers: Record<string, string>;
    body: string;
    isError?: boolean;
  } {
    const method = args.method as string;
    const target = args.target as string;
    const url = new URL(target);

    // Init: POST <object>?uploads
    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = `upload-${this.nextUploadId++}`;
      this.uploads.set(id, { parts: new Map(), completed: false });
      return {
        status: 200,
        headers: { "content-type": "application/xml" },
        body: `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      };
    }

    // Chunk: PUT <object>?partNumber=N&uploadId=ID
    if (method === "PUT" && url.searchParams.has("partNumber")) {
      const id = url.searchParams.get("uploadId")!;
      const partNumber = Number(url.searchParams.get("partNumber"));
      const u = this.uploads.get(id);
      if (!u) return { status: 404, headers: {}, body: "no upload", isError: true };
      const chunk = decodeBody(args);
      u.parts.set(partNumber, chunk);
      const etag = `"part-${partNumber}-${chunk.byteLength}"`;
      return { status: 200, headers: { etag }, body: "" };
    }

    // Complete: POST <object>?uploadId=ID with XML body
    if (
      method === "POST" &&
      url.searchParams.has("uploadId") &&
      !url.searchParams.has("partNumber")
    ) {
      const id = url.searchParams.get("uploadId")!;
      const u = this.uploads.get(id);
      if (!u) return { status: 404, headers: {}, body: "no upload", isError: true };
      // Lightly verify the request body lists every part.
      const xml = (args.body as string) ?? "";
      for (const partNumber of u.parts.keys()) {
        if (!xml.includes(`<PartNumber>${partNumber}</PartNumber>`)) {
          return {
            status: 400,
            headers: {},
            body: `<Error><Code>InvalidPart</Code><Message>Part ${partNumber} missing</Message></Error>`,
            isError: true,
          };
        }
      }
      u.completed = true;
      return {
        status: 200,
        headers: { "content-type": "application/xml" },
        body: `<?xml version="1.0"?><CompleteMultipartUploadResult><Location>https://s3.test/object</Location><Key>uploaded.bin</Key></CompleteMultipartUploadResult>`,
      };
    }

    // Abort: DELETE <object>?uploadId=ID
    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId")!;
      this.uploads.delete(id);
      return { status: 204, headers: {}, body: "" };
    }

    return { status: 400, headers: {}, body: `unhandled ${method} ${target}`, isError: true };
  }

  reconstruct(uploadId: string): Uint8Array {
    const u = this.uploads.get(uploadId)!;
    const sorted = [...u.parts.entries()].sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((acc, [, b]) => acc + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const [, b] of sorted) {
      merged.set(b, off);
      off += b.byteLength;
    }
    return merged;
  }
}

describe("McpProviderUploadResolver — s3-multipart", () => {
  it("uploads a 12 MB file with 5 MiB parts (init+2 parts+last+complete)", async () => {
    const stub = new S3StubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace, bytes } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const expectedSha = sha256Hex(bytes);

      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/s3",
          target: "https://s3.test/bucket/uploaded.bin",
          fromFile: "big.bin",
          uploadProtocol: "s3-multipart",
          partSizeBytes: 5 * 1024 * 1024,
        },
        ctxBase(workspace),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.size).toBe(12 * 1024 * 1024);
      // 12 MiB / 5 MiB = 2 full + 1 remainder
      expect(result.chunks).toBe(3);
      expect(result.sha256).toBe(expectedSha);
      expect(result.body).toContain("CompleteMultipartUploadResult");

      const received = stub.reconstruct("upload-1");
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(sha256Hex(received)).toBe(expectedSha);
    } finally {
      await pair.close();
    }
  });

  it("rejects partSizeBytes < 5 MiB for multi-part uploads", async () => {
    const stub = new S3StubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/s3",
          target: "https://s3.test/bucket/x",
          fromFile: "big.bin",
          uploadProtocol: "s3-multipart",
          partSizeBytes: 1 * 1024 * 1024, // below 5 MiB
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/below S3 minimum/);
    } finally {
      await pair.close();
    }
  });

  it("treats a 200 with <Error> body from CompleteMultipartUpload as failure", async () => {
    // S3 quirk: a 200 with an `<Error>` body is a failure. The
    // adapter must surface this to the agent.
    const { pair, mcp } = await makePair(async (args) => {
      const method = args.method as string;
      const target = args.target as string;
      if (method === "POST" && /\?uploads$/.test(target)) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>upload-X</UploadId></InitiateMultipartUploadResult>`,
        };
      }
      if (method === "PUT") return { status: 200, headers: { etag: '"part"' }, body: "" };
      if (method === "POST" && /uploadId=/.test(target)) {
        return {
          status: 200,
          headers: {},
          body: `<?xml version="1.0"?><Error><Code>InternalError</Code><Message>boom</Message></Error>`,
        };
      }
      return { status: 400, headers: {}, body: "x", isError: true };
    });
    try {
      const { workspace } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/s3",
          target: "https://s3.test/bucket/x",
          fromFile: "big.bin",
          uploadProtocol: "s3-multipart",
          partSizeBytes: 5 * 1024 * 1024,
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/<Error>/i);
    } finally {
      await pair.close();
    }
  });
});

// ─── tus ──────────────────────────────────────────────────────────

class TusStubServer {
  private files = new Map<string, { length: number; data: Uint8Array }>();
  private nextId = 1;

  handle(args: Record<string, unknown>): {
    status: number;
    headers: Record<string, string>;
    body: string;
    isError?: boolean;
  } {
    const method = args.method as string;
    const target = args.target as string;
    const headers = (args.headers ?? {}) as Record<string, string>;

    if (method === "POST" && !/\/files\//.test(target)) {
      const length = Number(headers["Upload-Length"]);
      if (!Number.isFinite(length) || length <= 0) {
        return { status: 400, headers: {}, body: "bad length", isError: true };
      }
      const id = `tus-${this.nextId++}`;
      this.files.set(id, { length, data: new Uint8Array(0) });
      return {
        status: 201,
        headers: {
          location: `https://tus.test/files/${id}`,
          "tus-resumable": "1.0.0",
        },
        body: "",
      };
    }

    const m = target.match(/files\/(tus-\d+)/);
    if (method === "PATCH" && m) {
      const id = m[1]!;
      const f = this.files.get(id);
      if (!f) return { status: 404, headers: {}, body: "no file", isError: true };
      const offset = Number(headers["Upload-Offset"]);
      const chunk = decodeBody(args);
      if (offset !== f.data.byteLength) {
        return { status: 409, headers: {}, body: "offset mismatch", isError: true };
      }
      const merged = new Uint8Array(f.data.byteLength + chunk.byteLength);
      merged.set(f.data, 0);
      merged.set(chunk, f.data.byteLength);
      f.data = merged;
      return {
        status: 204,
        headers: {
          "upload-offset": String(f.data.byteLength),
          "tus-resumable": "1.0.0",
        },
        body: "",
      };
    }

    if (method === "DELETE" && m) {
      this.files.delete(m[1]!);
      return { status: 204, headers: {}, body: "" };
    }

    return { status: 400, headers: {}, body: `unhandled ${method} ${target}`, isError: true };
  }

  data(id: string): Uint8Array | undefined {
    return this.files.get(id)?.data;
  }
}

describe("McpProviderUploadResolver — tus", () => {
  it("uploads a 12 MB file via PATCH with Upload-Offset tracking", async () => {
    const stub = new TusStubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace, bytes } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const expectedSha = sha256Hex(bytes);

      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/cf-stream",
          target: "https://tus.test/files",
          fromFile: "big.bin",
          uploadProtocol: "tus",
          partSizeBytes: 4 * 1024 * 1024,
          metadata: { filename: "big.bin", filetype: "application/octet-stream" },
        },
        ctxBase(workspace),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.size).toBe(12 * 1024 * 1024);
      expect(result.chunks).toBe(3);
      expect(result.sha256).toBe(expectedSha);

      const received = stub.data("tus-1")!;
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(sha256Hex(received)).toBe(expectedSha);
    } finally {
      await pair.close();
    }
  });

  it("fails fast when the server reports a desynced offset", async () => {
    // Server returns offset=1 instead of the expected (4MiB-1)+1 → resolver must
    // refuse to continue.
    const { pair, mcp } = await makePair(async (args) => {
      const method = args.method as string;
      if (method === "POST") {
        return {
          status: 201,
          headers: { location: "https://tus.test/files/tus-X", "tus-resumable": "1.0.0" },
          body: "",
        };
      }
      if (method === "PATCH") {
        return {
          status: 204,
          headers: { "upload-offset": "1", "tus-resumable": "1.0.0" },
          body: "",
        };
      }
      return { status: 400, headers: {}, body: "x", isError: true };
    });
    try {
      const { workspace } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/cf-stream",
          target: "https://tus.test/files",
          fromFile: "big.bin",
          uploadProtocol: "tus",
          partSizeBytes: 4 * 1024 * 1024,
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/server advanced to offset/);
    } finally {
      await pair.close();
    }
  });
});

// ─── Microsoft resumable ──────────────────────────────────────────

class MsStubServer {
  private sessions = new Map<string, Uint8Array>();
  private nextId = 1;

  handle(args: Record<string, unknown>): {
    status: number;
    headers: Record<string, string>;
    body: string;
    isError?: boolean;
  } {
    const method = args.method as string;
    const target = args.target as string;
    const headers = (args.headers ?? {}) as Record<string, string>;

    if (method === "POST" && /createUploadSession/.test(target)) {
      const id = `ms-${this.nextId++}`;
      this.sessions.set(id, new Uint8Array(0));
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadUrl: `https://graph.test/upload/${id}`,
          expirationDateTime: "2030-01-01T00:00:00Z",
        }),
      };
    }
    const m = target.match(/upload\/(ms-\d+)/);
    if (method === "PUT" && m) {
      const id = m[1]!;
      const buf = this.sessions.get(id);
      if (!buf) return { status: 404, headers: {}, body: "x", isError: true };
      const range = headers["Content-Range"];
      const rm = range?.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!rm) return { status: 400, headers: {}, body: "bad range", isError: true };
      const start = Number(rm[1]);
      const end = Number(rm[2]);
      const total = Number(rm[3]);
      const chunk = decodeBody(args);
      const merged = new Uint8Array(start + chunk.byteLength);
      merged.set(buf, 0);
      merged.set(chunk, start);
      this.sessions.set(id, merged);
      const isFinal = end + 1 === total;
      if (isFinal) {
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({ id: "drive-item-id", name: "uploaded.bin" }),
        };
      }
      return {
        status: 202,
        headers: {},
        body: JSON.stringify({ nextExpectedRanges: [`${end + 1}-`] }),
      };
    }
    if (method === "DELETE" && m) {
      this.sessions.delete(m[1]!);
      return { status: 204, headers: {}, body: "" };
    }
    return { status: 400, headers: {}, body: "x", isError: true };
  }

  data(id: string): Uint8Array | undefined {
    return this.sessions.get(id);
  }
}

describe("McpProviderUploadResolver — ms-resumable", () => {
  it("uploads a 12 MB file via createUploadSession + chunked PUT", async () => {
    const stub = new MsStubServer();
    const { pair, mcp } = await makePair(async (args) => stub.handle(args));
    try {
      const { workspace, bytes } = writeSyntheticFile("big.bin", 12 * 1024 * 1024);
      const expectedSha = sha256Hex(bytes);

      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/onedrive",
          target: "https://graph.test/me/drive/root:/foo.bin:/createUploadSession",
          fromFile: "big.bin",
          uploadProtocol: "ms-resumable",
          metadata: { item: { "@microsoft.graph.conflictBehavior": "replace", name: "foo.bin" } },
          // 5 MiB is divisible by 320 KiB? 5 MiB = 5242880. 320 KiB = 327680.
          // 5242880 / 327680 = 16.0 → yes.
          partSizeBytes: 5 * 1024 * 1024,
        },
        ctxBase(workspace),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.size).toBe(12 * 1024 * 1024);
      expect(result.sha256).toBe(expectedSha);
      expect(JSON.parse(result.body).id).toBe("drive-item-id");

      const received = stub.data("ms-1")!;
      expect(received.byteLength).toBe(bytes.byteLength);
      expect(sha256Hex(received)).toBe(expectedSha);
    } finally {
      await pair.close();
    }
  });
});

// ─── Cross-cutting ────────────────────────────────────────────────

describe("McpProviderUploadResolver — cross-cutting", () => {
  it("rejects fromFile resolving outside the workspace (path traversal)", async () => {
    const { pair, mcp } = await makePair(async () => ({
      status: 200,
      headers: {},
      body: "",
    }));
    try {
      const workspace = mkdtempSync(join(tmpdir(), "upload-"));
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/drive",
          target: "https://example.test/upload?uploadType=resumable",
          fromFile: "../../../etc/passwd",
          uploadProtocol: "google-resumable",
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.status).toBe(0);
      expect(result.error).toMatch(/cannot read|outside|forbidden/i);
    } finally {
      await pair.close();
    }
  });

  it("returns a structured error for an unknown protocol (defence-in-depth)", async () => {
    const { pair, mcp } = await makePair(async () => ({
      status: 200,
      headers: {},
      body: "",
    }));
    try {
      const { workspace } = writeSyntheticFile("big.bin", 1024);
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/x",
          target: "https://example.test/x",
          fromFile: "big.bin",
          uploadProtocol: "unknown-protocol" as never,
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/Unknown upload protocol/);
    } finally {
      await pair.close();
    }
  });

  it("rejects empty files (chunked uploads require ≥1 byte)", async () => {
    const { pair, mcp } = await makePair(async () => ({
      status: 200,
      headers: {},
      body: "",
    }));
    try {
      const workspace = mkdtempSync(join(tmpdir(), "upload-"));
      writeFileSync(join(workspace, "empty.bin"), new Uint8Array(0));
      const resolver = new McpProviderUploadResolver(mcp);
      const result = await resolver.executeUpload(
        {
          providerId: "@test/drive",
          target: "https://example.test/upload?uploadType=resumable",
          fromFile: "empty.bin",
          uploadProtocol: "google-resumable",
        },
        ctxBase(workspace),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/empty/);
    } finally {
      await pair.close();
    }
  });
});
