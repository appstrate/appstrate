// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-container workspace provisioning
 * (`runtime-pi/provision.ts`) — the boot-critical path that fetches the AFPS
 * bundle + input documents from the platform and writes them to disk.
 *
 * Drives the real `provisionWorkspace` / `provisionDocuments` against a local
 * HTTP server that VERIFIES the Standard-Webhooks HMAC (so signing correctness
 * is exercised, not mocked) and streams documents back chunked
 * (`transfer-encoding: chunked`, no content-length) — the exact shape the
 * platform's `/documents/:name` route serves. `die` is injected to throw, so
 * fatal paths surface as rejections instead of `process.exit`.
 *
 * NOTE: the original production bug — `Bun.write(path, Response)` busy-looping
 * — only reproduces in the BUNDLED runtime, so a source-level unit test cannot
 * trigger it. These tests pin the contract (correct bytes, streaming, fatal
 * paths) + completion-under-timeout; the bundled-only spin is covered by the
 * container e2e.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify } from "@appstrate/afps-runtime/events";
import {
  provisionWorkspace,
  provisionDocuments,
  signedGetWithRetry,
  type ProvisionDeps,
} from "../provision.ts";

const SECRET = "test-run-secret-0123456789";

/** Per-test server behaviour, reset in `beforeEach`. */
interface ServerConfig {
  requireSig: boolean;
  lastSigOk: boolean | null;
  /** Path-suffix → handler. Suffix matched against the URL pathname tail. */
  workspace: (req: Request) => Response | Promise<Response>;
  documents: (req: Request) => Response | Promise<Response>;
  doc: (name: string, req: Request) => Response | Promise<Response>;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let config: ServerConfig;

/** A chunked `Response` (no content-length) emitting `bytes` in `chunkSize` slices. */
function chunkedResponse(bytes: Uint8Array, chunkSize = 16): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      // Verify the HMAC the runtime signed (empty GET body).
      const sig = verify({
        msgId: req.headers.get("webhook-id") ?? "",
        timestampSec: Number(req.headers.get("webhook-timestamp") ?? "0"),
        body: "",
        secret: SECRET,
        signatureHeader: req.headers.get("webhook-signature") ?? "",
      });
      config.lastSigOk = sig.ok;
      if (config.requireSig && !sig.ok) {
        return new Response("bad signature", { status: 401 });
      }
      if (u.pathname.endsWith("/workspace")) return config.workspace(req);
      if (u.pathname.endsWith("/documents")) return config.documents(req);
      const m = u.pathname.match(/\/documents\/([^/]+)$/);
      if (m) return config.doc(decodeURIComponent(m[1]!), req);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  config = {
    requireSig: false,
    lastSigOk: null,
    workspace: () => new Response("bundle-bytes", { status: 200 }),
    documents: () => new Response("no docs", { status: 404 }),
    doc: () => new Response("missing", { status: 404 }),
  };
});

class DieError extends Error {}

/** A `die` that throws (instead of `process.exit`) so tests can assert. */
function makeDie(): { die: ProvisionDeps["die"]; messages: string[] } {
  const messages: string[] = [];
  const die = async (message: string): Promise<never> => {
    messages.push(message);
    throw new DieError(message);
  };
  return { die, messages };
}

let workspaces: string[] = [];
async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "provision-test-"));
  workspaces.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(workspaces.map((d) => rm(d, { recursive: true, force: true })));
  workspaces = [];
});

function deps(
  workspace: string,
  die: ProvisionDeps["die"],
  extra: Partial<ProvisionDeps> = {},
): ProvisionDeps {
  return {
    sinkUrl: `${base}/api/runs/run_test/events`,
    sinkSecret: SECRET,
    workspace,
    die,
    // No real backoff + small budget so retry tests are fast.
    sleep: async () => {},
    maxAttempts: 3,
    ...extra,
  };
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe("provisionWorkspace", () => {
  it("fetches the bundle with a valid signature and writes agent-package.afps", async () => {
    config.requireSig = true;
    config.workspace = () => new Response("AFPS-BUNDLE-BYTES", { status: 200 });
    const ws = await tempWorkspace();
    const { die } = makeDie();

    await provisionWorkspace(deps(ws, die));

    expect(config.lastSigOk).toBe(true); // signing is real, server verified it
    const written = await readFile(path.join(ws, "agent-package.afps"), "utf8");
    expect(written).toBe("AFPS-BUNDLE-BYTES");
  });

  it("dies on a 404 (the bundle is always uploaded — a miss is fatal, #549)", async () => {
    config.workspace = () => new Response("gone", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionWorkspace(deps(ws, die))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("HTTP 404");
  });

  it("dies on a rejected signature (401)", async () => {
    config.requireSig = true;
    const ws = await tempWorkspace();
    // Wrong secret → server returns 401, which signedGetWithRetry surfaces.
    const { die, messages } = makeDie();
    await expect(
      provisionWorkspace(deps(ws, die, { sinkSecret: "wrong-secret" })),
    ).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("HTTP 401");
  });

  it("retries a transient 503 then succeeds", async () => {
    let calls = 0;
    config.workspace = () => {
      calls += 1;
      return calls < 2
        ? new Response("try later", { status: 503 })
        : new Response("RECOVERED", { status: 200 });
    };
    const ws = await tempWorkspace();
    const { die } = makeDie();

    await provisionWorkspace(deps(ws, die));

    expect(calls).toBe(2);
    expect(await readFile(path.join(ws, "agent-package.afps"), "utf8")).toBe("RECOVERED");
  });

  it("dies after the retry budget is exhausted on persistent 5xx", async () => {
    config.workspace = () => new Response("down", { status: 503 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionWorkspace(deps(ws, die, { maxAttempts: 2 }))).rejects.toBeInstanceOf(
      DieError,
    );
    expect(messages[0]).toContain("after 2 attempts");
  });
});

describe("provisionDocuments", () => {
  it("is a no-op when the manifest 404s (run carries no documents)", async () => {
    config.documents = () => new Response("none", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionDocuments(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(await exists(path.join(ws, "documents"))).toBe(false);
  });

  it("is a no-op when the manifest is empty", async () => {
    config.documents = () => Response.json({ documents: [] });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionDocuments(deps(ws, die));
    expect(messages).toHaveLength(0);
  });

  it("streams every manifest document to documents/<name> with exact bytes", async () => {
    const files: Record<string, Uint8Array> = {
      "a.txt": new TextEncoder().encode("hello alpha"),
      "b.csv": new TextEncoder().encode("id,v\n1,2\n3,4\n"),
    };
    config.documents = () =>
      Response.json({
        documents: Object.entries(files).map(([name, b]) => ({
          name,
          workspace_name: name,
          size: b.byteLength,
        })),
      });
    config.doc = (name) => chunkedResponse(files[name]!);
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionDocuments(deps(ws, die));

    expect(messages).toHaveLength(0);
    for (const [name, bytes] of Object.entries(files)) {
      const onDisk = await readFile(path.join(ws, "documents", name));
      expect(Buffer.compare(onDisk, Buffer.from(bytes))).toBe(0);
    }
  });

  it("keys writes on workspace_name, not the (possibly colliding) display name", async () => {
    // Two documents share the human display name `report.pdf` but the platform
    // disambiguated their workspace names — the container must write BOTH,
    // under the distinct workspace names, never overwriting one with the other.
    const a = new TextEncoder().encode("first report");
    const b = new TextEncoder().encode("second report, longer");
    config.documents = () =>
      Response.json({
        documents: [
          { name: "report.pdf", workspace_name: "report.pdf", size: a.byteLength },
          { name: "report.pdf", workspace_name: "report-2.pdf", size: b.byteLength },
        ],
      });
    config.doc = (name) => chunkedResponse(name === "report.pdf" ? a : b);
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionDocuments(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(
      Buffer.compare(await readFile(path.join(ws, "documents", "report.pdf")), Buffer.from(a)),
    ).toBe(0);
    expect(
      Buffer.compare(await readFile(path.join(ws, "documents", "report-2.pdf")), Buffer.from(b)),
    ).toBe(0);
  });

  it("streams a large multi-chunk document byte-exact (reader loop + backpressure)", async () => {
    // 1 MiB of deterministic bytes, served in 16-byte chunks → exercises the
    // chunk-by-chunk reader loop the fix relies on.
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    config.documents = () =>
      Response.json({
        documents: [{ name: "big.bin", workspace_name: "big.bin", size: big.length }],
      });
    config.doc = () => chunkedResponse(big, 16);
    const ws = await tempWorkspace();
    const { die } = makeDie();

    await provisionDocuments(deps(ws, die));

    const onDisk = await readFile(path.join(ws, "documents", "big.bin"));
    expect(onDisk.byteLength).toBe(big.byteLength);
    expect(Buffer.compare(onDisk, Buffer.from(big))).toBe(0);
  });

  it("dies when a listed document fetch returns non-ok", async () => {
    config.documents = () =>
      Response.json({ documents: [{ name: "x.txt", workspace_name: "x.txt", size: 1 }] });
    config.doc = () => new Response("gone", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionDocuments(deps(ws, die))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("x.txt");
  });

  it("dies (does not crash) when a document body errors mid-stream", async () => {
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();
    // Inject the transport so the document body rejects on read deterministically
    // (a server-side stream abort surfaces client-side as a clean EOF, not a
    // read error — so it can't exercise the write-loop catch).
    const fetchFn = (async (url: string | URL): Promise<Response> => {
      if (String(url).endsWith("/documents")) {
        return Response.json({
          documents: [{ name: "partial.bin", workspace_name: "partial.bin", size: 9 }],
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
        },
        pull(c) {
          c.error(new Error("connection reset mid-stream"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(provisionDocuments(deps(ws, die, { fetchFn }))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("stream document partial.bin");
  });

  it("refuses a path-traversal document name without fetching it", async () => {
    config.documents = () =>
      Response.json({ documents: [{ name: "../evil", workspace_name: "../evil" }] });
    let docFetched = false;
    config.doc = () => {
      docFetched = true;
      return new Response("nope", { status: 200 });
    };
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionDocuments(deps(ws, die))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("unsafe document name");
    expect(docFetched).toBe(false);
  });

  it("dies if the manifest itself errors with a non-404 status", async () => {
    config.documents = () => new Response("boom", { status: 500 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionDocuments(deps(ws, die, { maxAttempts: 1 }))).rejects.toBeInstanceOf(
      DieError,
    );
    expect(messages[0]).toContain("documents manifest");
  });
});

describe("signedGetWithRetry", () => {
  it("does not retry a deterministic 4xx (returns it immediately)", async () => {
    let calls = 0;
    config.documents = () => {
      calls += 1;
      return new Response("nope", { status: 403 });
    };
    const ws = await tempWorkspace();
    const { die } = makeDie();
    const res = await signedGetWithRetry(`${base}/api/runs/run_test/documents`, deps(ws, die));
    expect(res.status).toBe(403);
    expect(calls).toBe(1); // 403 is non-retryable
  });

  it("signs every request (server-side HMAC verify passes)", async () => {
    config.requireSig = true;
    config.documents = () => new Response("ok", { status: 200 });
    const ws = await tempWorkspace();
    const { die } = makeDie();
    const res = await signedGetWithRetry(`${base}/api/runs/run_test/documents`, deps(ws, die));
    expect(res.status).toBe(200);
    expect(config.lastSigOk).toBe(true);
  });
});
