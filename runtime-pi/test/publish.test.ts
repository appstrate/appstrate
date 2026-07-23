// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-container document publishing path
 * (`runtime-pi/publish.ts`) + the `publish_document` runtime tool def.
 *
 * Drives the real `createRunDocumentUploader` / `sweepOutputs` against a local
 * HTTP server that VERIFIES the Standard-Webhooks HMAC over an EMPTY body (the
 * exact shape `POST /api/runs/:id/documents` expects) and returns a 201 with the
 * server-computed sha256 — so signing + streaming + dedup are exercised for
 * real, not mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify } from "@appstrate/afps-runtime/events";
import { buildPublishDocumentDef } from "@appstrate/core/runtime-tool-defs";
import { createRunDocumentUploader, sweepOutputs, uploadTimeoutMs } from "../publish.ts";
import type { RunDocumentUploaderDeps } from "../publish.ts";

const SECRET = "test-run-secret-0123456789";

interface Received {
  name: string | null;
  contentType: string | null;
  sha256: string;
  size: number;
}

interface ServerConfig {
  /** Default HTTP status when `statusQueue` is empty (2xx → success JSON, else error). */
  status: number;
  /** Per-request status sequence (consumed FIFO) — drives retry scenarios. */
  statusQueue: number[];
  /** `Retry-After` header value to attach to a 429 response, if set. */
  retryAfter?: string;
  received: Received[];
}

let server: ReturnType<typeof Bun.serve>;
let sinkUrl: string; // .../api/runs/:id/events (uploader swaps to /documents)
let config: ServerConfig;

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const sig = verify({
        msgId: req.headers.get("webhook-id") ?? "",
        timestampSec: Number(req.headers.get("webhook-timestamp") ?? "0"),
        body: "",
        secret: SECRET,
        signatureHeader: req.headers.get("webhook-signature") ?? "",
      });
      if (!sig.ok) return new Response("bad signature", { status: 401 });
      if (!u.pathname.endsWith("/documents")) return new Response("not found", { status: 404 });

      const bytes = new Uint8Array(await req.arrayBuffer());
      const sha256 = sha256Hex(bytes);
      const name = req.headers.get("x-document-name");
      config.received.push({
        name,
        contentType: req.headers.get("content-type"),
        sha256,
        size: bytes.byteLength,
      });
      const status = config.statusQueue.length > 0 ? config.statusQueue.shift()! : config.status;
      if (status < 200 || status >= 300) {
        const headers: Record<string, string> = {};
        if (status === 429 && config.retryAfter !== undefined) {
          headers["retry-after"] = config.retryAfter;
        }
        return new Response(`error ${status}`, { status, headers });
      }
      const id = `doc_${sha256.slice(0, 12)}`;
      return Response.json({
        id,
        uri: `document://${id}`,
        name: name ?? "unknown",
        mime: req.headers.get("content-type") ?? "application/octet-stream",
        size: bytes.byteLength,
        sha256,
      });
    },
  });
  sinkUrl = `http://localhost:${server.port}/api/runs/run_x/events`;
});

afterAll(() => server.stop(true));

let workspace: string;

beforeEach(async () => {
  config = { status: 201, statusQueue: [], received: [] };
  // `realpath`: on macOS `tmpdir()` (`/var/folders/…`) is a symlink to
  // `/private/var/folders/…`. The resolver canonicalizes the workspace
  // root before comparing resolved paths to it, so an unresolved root makes
  // every path look like a symlink escape. Real runs mount a real directory;
  // only the fixture needs this.
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), "publish-test-")));
});

function makeUploader(publishedShas: Set<string>, overrides?: Partial<RunDocumentUploaderDeps>) {
  return createRunDocumentUploader({
    sinkUrl,
    sinkSecret: SECRET,
    workspace,
    publishedShas,
    // No real backoff waits in tests; retry-specific cases inject a recorder.
    sleepFn: async () => {},
    ...overrides,
  });
}

describe("createRunDocumentUploader", () => {
  it("streams a workspace file to /documents and records its sha", async () => {
    const bytes = new TextEncoder().encode("<html>hello</html>");
    await writeFile(path.join(workspace, "report.html"), bytes);
    const shas = new Set<string>();

    const doc = await makeUploader(shas)("report.html");

    expect(doc.name).toBe("report.html");
    expect(doc.size).toBe(bytes.byteLength);
    expect(doc.sha256).toBe(sha256Hex(bytes));
    expect(doc.uri).toBe(`document://${doc.id}`);
    expect(shas.has(doc.sha256)).toBe(true);
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("report.html");
    expect(config.received[0]!.contentType).toBe("text/html");
  });

  it("honours a display-name override", async () => {
    await writeFile(path.join(workspace, "raw.bin"), new Uint8Array([1, 2, 3]));
    const doc = await makeUploader(new Set())("raw.bin", "Nice Name.bin");
    expect(doc.name).toBe("Nice Name.bin");
    expect(config.received[0]!.name).toBe("Nice Name.bin");
  });

  it("throws on a missing file", async () => {
    await expect(makeUploader(new Set())("nope.txt")).rejects.toThrow(/ENOENT/);
  });

  it("rejects a path escaping the allowed roots", async () => {
    await expect(makeUploader(new Set())("../../../../../../etc/passwd")).rejects.toThrow(
      /outside the allowed roots/,
    );
  });

  it("rejects absolute paths, including files under /tmp", async () => {
    const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "publish-outside-")));
    const outsideFile = path.join(scratch, "secret.txt");
    await writeFile(outsideFile, "not a workspace artifact");

    await expect(makeUploader(new Set())(outsideFile)).rejects.toThrow(/workspace-relative/);
    expect(config.received).toHaveLength(0);
  });

  it("rejects a symlink pointing outside the allowed roots, uploading nothing", async () => {
    const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "publish-link-outside-")));
    const outsideFile = path.join(scratch, "secret.txt");
    await writeFile(outsideFile, "not a workspace artifact");
    await symlink(outsideFile, path.join(workspace, "link.txt"));

    await expect(makeUploader(new Set())("link.txt")).rejects.toThrow(/outside the allowed roots/);
    expect(config.received).toHaveLength(0);
  });

  it("rejects a dangling symlink via the lstat gate, uploading nothing", async () => {
    // A dangling link cannot be realpathed end-to-end, so the canonical path
    // keeps the link as its final component and the lstat symlink gate fires.
    await symlink(path.join(workspace, "nope-target.txt"), path.join(workspace, "dangling.txt"));

    await expect(makeUploader(new Set())("dangling.txt")).rejects.toThrow(/symlink/);
    expect(config.received).toHaveLength(0);
  });

  it("surfaces a non-2xx response as an error", async () => {
    config.status = 413;
    await writeFile(path.join(workspace, "big.txt"), new TextEncoder().encode("x"));
    await expect(makeUploader(new Set())("big.txt")).rejects.toThrow(/413/);
  });

  it("retries a 5xx then succeeds", async () => {
    // First attempt 500, second 201 — the file is published after one retry.
    config.statusQueue = [500, 201];
    const bytes = new TextEncoder().encode("retry-me");
    await writeFile(path.join(workspace, "r.txt"), bytes);
    const shas = new Set<string>();

    const doc = await makeUploader(shas)("r.txt");

    expect(doc.sha256).toBe(sha256Hex(bytes));
    expect(config.received).toHaveLength(2); // one failed + one successful attempt
    expect(shas.has(doc.sha256)).toBe(true);
  });

  it("does not retry a definitive 413", async () => {
    config.statusQueue = [413, 201]; // second entry must never be reached
    await writeFile(path.join(workspace, "cap.txt"), new TextEncoder().encode("x"));

    await expect(makeUploader(new Set())("cap.txt")).rejects.toThrow(/413/);
    expect(config.received).toHaveLength(1); // stopped after the first attempt
  });

  it("honours Retry-After on a 429 before retrying", async () => {
    config.statusQueue = [429, 201];
    config.retryAfter = "2"; // seconds
    await writeFile(path.join(workspace, "throttled.txt"), new TextEncoder().encode("y"));
    const slept: number[] = [];

    const doc = await makeUploader(new Set(), {
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    })("throttled.txt");

    expect(doc.name).toBe("throttled.txt");
    expect(config.received).toHaveLength(2);
    // The 429's Retry-After (2s) drove the wait, not the default backoff.
    expect(slept).toEqual([2000]);
  });

  it("abandons after 3 failed attempts with a clear error", async () => {
    config.status = 500; // every attempt fails
    await writeFile(path.join(workspace, "doomed.txt"), new TextEncoder().encode("z"));

    await expect(makeUploader(new Set())("doomed.txt")).rejects.toThrow(/after 3 attempts/);
    expect(config.received).toHaveLength(3);
  });
});

describe("uploadTimeoutMs", () => {
  it("is a fixed base plus time proportional to the byte count", () => {
    // 0 bytes → just the base; larger files add ~1s per MiB (1 MiB/s floor).
    expect(uploadTimeoutMs(0)).toBe(30_000);
    expect(uploadTimeoutMs(1024 * 1024)).toBe(31_000);
    expect(uploadTimeoutMs(10 * 1024 * 1024)).toBe(40_000);
    // Monotonic and never below the base, even for a negative/garbage size.
    expect(uploadTimeoutMs(-5)).toBe(30_000);
    expect(uploadTimeoutMs(5 * 1024 * 1024)).toBeGreaterThan(uploadTimeoutMs(1024 * 1024));
  });
});

describe("sweepOutputs", () => {
  async function seedOutput(rel: string, content: string): Promise<void> {
    const abs = path.join(workspace, "outputs", rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, new TextEncoder().encode(content));
  }

  it("publishes every unpublished file under outputs/ and emits events", async () => {
    await seedOutput("a.txt", "alpha");
    await seedOutput("nested/b.csv", "b,c");
    const shas = new Set<string>();
    const events: Array<Record<string, unknown>> = [];

    await sweepOutputs({
      uploader: makeUploader(shas),
      workspace,
      publishedShas: shas,
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "document.published")).toBe(true);
    // Every emitted doc's sha is now tracked.
    for (const e of events) expect(shas.has(e.sha256 as string)).toBe(true);
  });

  it("skips a file whose sha was already published (dedup)", async () => {
    await seedOutput("dup.txt", "already-published");
    const shas = new Set<string>([sha256Hex(new TextEncoder().encode("already-published"))]);
    const events: unknown[] = [];

    await sweepOutputs({
      uploader: makeUploader(shas),
      workspace,
      publishedShas: shas,
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("skips a symlink under outputs/ with a warning and publishes regular files", async () => {
    // outputs/ holds one real file + one symlink to an outside target. The
    // sweep must publish the real file and skip the symlink with a warning —
    // never following it to the outside target (`lstat`, not `stat`).
    const outside = await mkdtemp(path.join(tmpdir(), "publish-outside-"));
    await writeFile(path.join(outside, "secret.txt"), new TextEncoder().encode("secret"));
    await seedOutput("real.txt", "real-content");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "outputs", "link.txt"));

    const shas = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await sweepOutputs({
      uploader: makeUploader(shas),
      workspace,
      publishedShas: shas,
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
      logWarn: (m) => warnings.push(m),
    });

    // Only the regular file reached the server; the symlink never did.
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("real.txt");
    expect(events).toHaveLength(1);
    expect(warnings.some((w) => /symlink/.test(w))).toBe(true);
  });

  it("skips an oversized file with a warning and never throws", async () => {
    await seedOutput("huge.txt", "0123456789");
    const warnings: string[] = [];

    await sweepOutputs({
      uploader: makeUploader(new Set()),
      workspace,
      publishedShas: new Set(),
      maxFileBytes: 4,
      emit: () => {},
      logWarn: (m) => warnings.push(m),
    });

    expect(config.received).toHaveLength(0);
    expect(warnings.some((w) => /oversized/.test(w))).toBe(true);
  });

  it("no-ops when outputs/ does not exist", async () => {
    const events: unknown[] = [];
    await expect(
      sweepOutputs({
        uploader: makeUploader(new Set()),
        workspace,
        publishedShas: new Set(),
        maxFileBytes: 1024,
        emit: (e) => {
          events.push(e);
        },
      }),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("swallows a per-file upload failure and never blocks finalize", async () => {
    config.status = 500;
    await seedOutput("fails.txt", "boom");
    const warnings: string[] = [];
    const events: unknown[] = [];

    await sweepOutputs({
      uploader: makeUploader(new Set()),
      workspace,
      publishedShas: new Set(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
      logWarn: (m) => warnings.push(m),
    });

    expect(events).toHaveLength(0);
    expect(warnings.some((w) => /dropped a deliverable/.test(w))).toBe(true);
  });

  it("skips a hidden dotfile at the root and publishes regular files", async () => {
    await seedOutput(".env", "SECRET=shh");
    await seedOutput("report.md", "# ok");
    const shas = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await sweepOutputs({
      uploader: makeUploader(shas),
      workspace,
      publishedShas: shas,
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
      logWarn: (m) => warnings.push(m),
    });

    // Only the regular file was published; the dotfile never reached the server.
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("report.md");
    expect(events).toHaveLength(1);
    expect(warnings.some((w) => /hidden file/.test(w))).toBe(true);
  });

  it("skips a file nested inside a hidden directory", async () => {
    await seedOutput(".git/config", "[core]");
    await seedOutput("data.csv", "a,b");
    const shas = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await sweepOutputs({
      uploader: makeUploader(shas),
      workspace,
      publishedShas: shas,
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
      logWarn: (m) => warnings.push(m),
    });

    // The file under `.git/` is excluded; the normal file is published.
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("data.csv");
    expect(warnings.some((w) => /hidden file/.test(w))).toBe(true);
  });
});

describe("buildPublishDocumentDef (publish_document tool)", () => {
  it("uploads and emits a document.published event on success", async () => {
    await writeFile(path.join(workspace, "out.html"), new TextEncoder().encode("<h1>ok</h1>"));
    const def = buildPublishDocumentDef(makeUploader(new Set()));

    const result = await def.handler({ path: "out.html" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Published");
    const events = (result._meta?.["dev.appstrate/events"] ?? []) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("document.published");
    expect(events[0]!.document_id).toMatch(/^doc_/);
  });

  it("returns a tool error (not a throw) when the upload fails", async () => {
    const def = buildPublishDocumentDef(makeUploader(new Set()));
    const result = await def.handler({ path: "missing.txt" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Failed to publish");
  });

  it("returns a tool error when path is missing", async () => {
    const def = buildPublishDocumentDef(makeUploader(new Set()));
    const result = await def.handler({});
    expect(result.isError).toBe(true);
  });

  it("still publishes an explicitly-chosen dotfile (hidden filter is sweep-only)", async () => {
    // The hidden-file exclusion applies ONLY to the implicit outputs sweep; an
    // agent deliberately publishing a dotfile via the tool is honoured.
    await writeFile(path.join(workspace, ".config"), new TextEncoder().encode("k=v"));
    const def = buildPublishDocumentDef(makeUploader(new Set()));

    const result = await def.handler({ path: ".config" });

    expect(result.isError).toBeUndefined();
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe(".config");
  });
});
