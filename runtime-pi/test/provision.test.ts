// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-container workspace provisioning
 * (`runtime-pi/provision.ts`) — the boot-critical path that fetches the AFPS
 * bundle + input files from the platform and writes them to disk.
 *
 * Drives the real `provisionWorkspace` / `provisionFiles` against a local
 * HTTP server that VERIFIES the Standard-Webhooks HMAC (so signing correctness
 * is exercised, not mocked) and streams files back chunked
 * (`transfer-encoding: chunked`, no content-length) — the exact shape the
 * platform's `/files/:name` route serves. `die` is injected to throw, so
 * fatal paths surface as rejections instead of `process.exit`.
 *
 * NOTE: the original production bug — `Bun.write(path, Response)` busy-looping
 * — only reproduces in the BUNDLED runtime, so a source-level unit test cannot
 * trigger it. These tests pin the contract (correct bytes, streaming, fatal
 * paths) + completion-under-timeout; the bundled-only spin is covered by the
 * container e2e.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify } from "@appstrate/afps-runtime/events";
import {
  provisionWorkspace,
  provisionFiles,
  signedGetWithRetry,
  type ProvisionDeps,
} from "../provision.ts";

const SECRET = "test-run-secret-0123456789";

/** Per-test server behaviour, reset in `beforeEach`. */
interface ServerConfig {
  requireSig: boolean;
  lastSigOk: boolean | null;
  /** Every pathname the runtime requested, in order. */
  requestedPaths: string[];
  /** Path-suffix → handler. Suffix matched against the URL pathname tail. */
  workspace: (req: Request) => Response | Promise<Response>;
  files: (req: Request) => Response | Promise<Response>;
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
      config.requestedPaths.push(u.pathname);
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
      if (u.pathname.endsWith("/files")) return config.files(req);
      const m = u.pathname.match(/\/files\/([^/]+)$/);
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
    requestedPaths: [],
    workspace: () => new Response("bundle-bytes", { status: 200 }),
    files: () => new Response("no files", { status: 404 }),
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

describe("provisionFiles", () => {
  it("is a no-op when the manifest 404s (run carries no files)", async () => {
    config.files = () => new Response("none", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(await exists(path.join(ws, "files"))).toBe(false);
  });

  it("is a no-op when the manifest is empty", async () => {
    config.files = () => Response.json({ files: [] });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));
    expect(messages).toHaveLength(0);
  });

  it("streams every manifest file to files/<name> with exact bytes", async () => {
    const files: Record<string, Uint8Array> = {
      "a.txt": new TextEncoder().encode("hello alpha"),
      "b.csv": new TextEncoder().encode("id,v\n1,2\n3,4\n"),
    };
    config.files = () =>
      Response.json({
        files: Object.entries(files).map(([name, b]) => ({
          name,
          workspace_name: name,
          size: b.byteLength,
        })),
      });
    config.doc = (name) => chunkedResponse(files[name]!);
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    for (const [name, bytes] of Object.entries(files)) {
      const onDisk = await readFile(path.join(ws, "files", name));
      expect(Buffer.compare(onDisk, Buffer.from(bytes))).toBe(0);
    }
  });

  it("provisions into files/ only — no retired documents/ directory", async () => {
    // `files/` is the directory the platform prompt announces (`./files/<name>`,
    // unconditionally). The retired `documents/` symlink is gone: nothing
    // announces that path any more, and a second name for the same bytes is
    // one more thing that can drift out of step with the prompt.
    const bytes = new TextEncoder().encode("mounted");
    config.files = () =>
      Response.json({
        files: [{ name: "m.txt", workspace_name: "m.txt", size: bytes.byteLength }],
      });
    config.doc = () => chunkedResponse(bytes);
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(
      Buffer.compare(await readFile(path.join(ws, "files", "m.txt")), Buffer.from(bytes)),
    ).toBe(0);
    expect(await exists(path.join(ws, "documents"))).toBe(false);
  });

  it("ignores a manifest carrying only the retired `documents` key", async () => {
    // `files` is the only key read. No platform this image can talk to emits
    // the retired spelling — the platform validates its runtime image tags
    // against its own version at boot — so a `files`-less manifest is a
    // malformed one, and "no input files" is the honest reading of it.
    config.files = () =>
      Response.json({
        documents: [{ name: "k.txt", workspace_name: "k.txt", size: 3 }],
      });
    config.doc = () => chunkedResponse(new TextEncoder().encode("nope"));
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(await exists(path.join(ws, "files", "k.txt"))).toBe(false);
  });

  it("does not probe the retired /documents manifest path on a 404", async () => {
    // A 404 on `/files` now carries exactly one meaning — this run has no
    // input files — so there is no second round-trip on the common boot path.
    config.files = () => new Response("no files", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(config.requestedPaths.filter((p) => p.endsWith("/documents"))).toEqual([]);
    expect(config.requestedPaths.filter((p) => p.endsWith("/files"))).toHaveLength(1);
  });

  it("keys writes on workspace_name, not the (possibly colliding) display name", async () => {
    // Two files share the human display name `report.pdf` but the platform
    // disambiguated their workspace names — the container must write BOTH,
    // under the distinct workspace names, never overwriting one with the other.
    const a = new TextEncoder().encode("first report");
    const b = new TextEncoder().encode("second report, longer");
    config.files = () =>
      Response.json({
        files: [
          { name: "report.pdf", workspace_name: "report.pdf", size: a.byteLength },
          { name: "report.pdf", workspace_name: "report-2.pdf", size: b.byteLength },
        ],
      });
    config.doc = (name) => chunkedResponse(name === "report.pdf" ? a : b);
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await provisionFiles(deps(ws, die));

    expect(messages).toHaveLength(0);
    expect(
      Buffer.compare(await readFile(path.join(ws, "files", "report.pdf")), Buffer.from(a)),
    ).toBe(0);
    expect(
      Buffer.compare(await readFile(path.join(ws, "files", "report-2.pdf")), Buffer.from(b)),
    ).toBe(0);
  });

  it("streams a large multi-chunk file byte-exact (reader loop + backpressure)", async () => {
    // 1 MiB of deterministic bytes, served in 16-byte chunks → exercises the
    // chunk-by-chunk reader loop the fix relies on.
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    config.files = () =>
      Response.json({
        files: [{ name: "big.bin", workspace_name: "big.bin", size: big.length }],
      });
    config.doc = () => chunkedResponse(big, 16);
    const ws = await tempWorkspace();
    const { die } = makeDie();

    await provisionFiles(deps(ws, die));

    const onDisk = await readFile(path.join(ws, "files", "big.bin"));
    expect(onDisk.byteLength).toBe(big.byteLength);
    expect(Buffer.compare(onDisk, Buffer.from(big))).toBe(0);
  });

  it("dies when a listed file fetch returns non-ok", async () => {
    config.files = () =>
      Response.json({ files: [{ name: "x.txt", workspace_name: "x.txt", size: 1 }] });
    config.doc = () => new Response("gone", { status: 404 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionFiles(deps(ws, die))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("x.txt");
  });

  it("dies (does not crash) when a file body errors mid-stream", async () => {
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();
    // Inject the transport so the file body rejects on read deterministically
    // (a server-side stream abort surfaces client-side as a clean EOF, not a
    // read error — so it can't exercise the write-loop catch).
    const fetchFn = (async (url: string | URL): Promise<Response> => {
      if (String(url).endsWith("/files")) {
        return Response.json({
          files: [{ name: "partial.bin", workspace_name: "partial.bin", size: 9 }],
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

    await expect(provisionFiles(deps(ws, die, { fetchFn }))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("stream file partial.bin");
  });

  it("refuses a path-traversal file name without fetching it", async () => {
    config.files = () => Response.json({ files: [{ name: "../evil", workspace_name: "../evil" }] });
    let docFetched = false;
    config.doc = () => {
      docFetched = true;
      return new Response("nope", { status: 200 });
    };
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionFiles(deps(ws, die))).rejects.toBeInstanceOf(DieError);
    expect(messages[0]).toContain("unsafe file name");
    expect(docFetched).toBe(false);
  });

  it("dies if the manifest itself errors with a non-404 status", async () => {
    config.files = () => new Response("boom", { status: 500 });
    const ws = await tempWorkspace();
    const { die, messages } = makeDie();

    await expect(provisionFiles(deps(ws, die, { maxAttempts: 1 }))).rejects.toBeInstanceOf(
      DieError,
    );
    expect(messages[0]).toContain("files manifest");
  });
});

describe("signedGetWithRetry", () => {
  it("does not retry a deterministic 4xx (returns it immediately)", async () => {
    let calls = 0;
    config.files = () => {
      calls += 1;
      return new Response("nope", { status: 403 });
    };
    const ws = await tempWorkspace();
    const { die } = makeDie();
    const res = await signedGetWithRetry(`${base}/api/runs/run_test/files`, deps(ws, die));
    expect(res.status).toBe(403);
    expect(calls).toBe(1); // 403 is non-retryable
  });

  it("signs every request (server-side HMAC verify passes)", async () => {
    config.requireSig = true;
    config.files = () => new Response("ok", { status: 200 });
    const ws = await tempWorkspace();
    const { die } = makeDie();
    const res = await signedGetWithRetry(`${base}/api/runs/run_test/files`, deps(ws, die));
    expect(res.status).toBe(200);
    expect(config.lastSigOk).toBe(true);
  });
});

/**
 * The per-attempt headers deadline. Without it, an attempt that never settles
 * consumes the WHOLE retry budget — the documented 9-attempt / ~9.7 s span is
 * never reached and agent boot hangs forever, with nothing behind it (the run
 * watchdog's agent budget starts at the run loop, boot excluded).
 *
 * Fake timers, not real sleeps: the deadline is 10 s and a suite that actually
 * waits for it is not worth having.
 */
describe("signedGetWithRetry — per-attempt headers deadline", () => {
  /** Let the pending promise chain advance without any wall-clock wait. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it("times out a hung attempt and spends exactly one attempt of the budget on it", async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      // Never settles on its own — only the caller's signal ends it, exactly
      // like a platform that accepts the connection and never answers.
      const hangingFetch = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const signal = init?.signal;
        if (!signal) throw new Error("provisioning GET carried no AbortSignal — it can hang");
        signals.push(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }) as unknown as typeof fetch;

      const ws = await tempWorkspace();
      const { die } = makeDie();
      // Capture the outcome eagerly so a rejection is never unhandled.
      const settled = signedGetWithRetry(
        `${base}/api/runs/run_test/files`,
        deps(ws, die, { fetchFn: hangingFetch, maxAttempts: 3 }),
      ).then(
        () => "resolved" as const,
        (err: unknown) => err,
      );

      for (let attempt = 1; attempt <= 3; attempt++) {
        await flushMicrotasks();
        // Each attempt is reached only because the previous one gave up.
        expect(signals).toHaveLength(attempt);
        jest.advanceTimersByTime(11_000);
      }
      await flushMicrotasks();

      const outcome = await settled;
      // The budget is REACHED and then exhausted — the whole point.
      expect((outcome as Error).message).toContain("failed after 3 attempts");
      expect(signals).toHaveLength(3);
      // Every attempt died on the deadline, not on some other fault.
      for (const signal of signals) expect((signal.reason as Error).name).toBe("TimeoutError");
    } finally {
      jest.useRealTimers();
    }
  });

  // Control: the same path against a platform that answers. If the deadline
  // fired indiscriminately — or the signal broke the request outright — this
  // fails, so the test above cannot pass by way of a broken fetch path.
  it("an attempt answered inside the deadline succeeds and is not retried", async () => {
    let calls = 0;
    config.files = () => {
      calls += 1;
      return new Response("prompt-bytes", { status: 200 });
    };
    const ws = await tempWorkspace();
    const { die } = makeDie();

    const res = await signedGetWithRetry(`${base}/api/runs/run_test/files`, deps(ws, die));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("prompt-bytes");
    expect(calls).toBe(1);
  });

  // The half a whole-request `AbortSignal.timeout` would get wrong:
  // `provisionFiles` streams input files (up to 256 MiB) off the very Response
  // this function returns, so the deadline must cover the HEADERS only.
  it("disarms once the headers land — a body slower than the deadline still completes", async () => {
    jest.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      let push: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = controller;
        },
      });
      const headersThenSilence = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        captured = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const ws = await tempWorkspace();
      const { die } = makeDie();
      const res = await signedGetWithRetry(
        `${base}/api/runs/run_test/files/big.bin`,
        deps(ws, die, { fetchFn: headersThenSilence }),
      );
      expect(res.status).toBe(200);

      // Six times the per-attempt deadline later, the transfer is still live.
      jest.advanceTimersByTime(60_000);
      expect(captured?.aborted).toBe(false);

      push!.enqueue(new TextEncoder().encode("late-bytes"));
      push!.close();
      expect(await res.text()).toBe("late-bytes");
    } finally {
      jest.useRealTimers();
    }
  });
});
