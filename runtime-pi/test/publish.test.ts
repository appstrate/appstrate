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
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sign, verify } from "@appstrate/afps-runtime/events";
import { buildPublishDocumentDef } from "@appstrate/core/runtime-tool-defs";
import { decodeFilenameHeader, sanitizeFilename } from "@appstrate/core/naming";
import { unzipArtifact } from "@appstrate/core/zip";
import {
  createRunArchivePublisher,
  createRunDocumentUploader,
  sweepOutputs,
  summarizeArtifacts,
  uploadTimeoutMs,
  UploadError,
} from "../publish.ts";
import type { RunDocumentUploaderDeps, UploadFailureCode } from "../publish.ts";

const SECRET = "test-run-secret-0123456789";

interface Received {
  /** Sanitized name the server would store, i.e. `documents.name`. */
  name: string;
  /** The raw `X-Document-Name` wire value, before decoding. */
  rawHeader: string;
  contentType: string | null;
  presentation: string | null;
  sha256: string;
  size: number;
}

interface ServerConfig {
  /** Default HTTP status when `statusQueue` is empty (2xx -> success JSON, else error). */
  status: number;
  /** Per-request status sequence (consumed FIFO) - drives retry scenarios. */
  statusQueue: number[];
  /** `Retry-After` header value to attach to a 429 response, if set. */
  retryAfter?: string;
  received: Received[];
}

let server: ReturnType<typeof Bun.serve>;
let sinkUrl: string; // .../api/runs/:id/events (uploader swaps to /documents)
let documentsUrl: string; // the same URL with /events swapped for /documents
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
      // Mirrors `POST /api/runs/:runId/documents` in
      // `apps/api/src/routes/runs-events.ts`: the name header is a
      // percent-encoded UTF-8 filename, decoded STRICTLY (a malformed or
      // un-encoded value is a typed 400, never a guess) and then sanitized into
      // the value stored as `documents.name`.
      const rawHeader = req.headers.get("x-document-name");
      const decoded = rawHeader === null ? null : decodeFilenameHeader(rawHeader);
      if (rawHeader === null || decoded === null) {
        return Response.json(
          { error: { code: "invalid_request", param: "X-Document-Name" } },
          { status: 400 },
        );
      }
      const name = sanitizeFilename(decoded);
      config.received.push({
        name,
        rawHeader,
        contentType: req.headers.get("content-type"),
        presentation: req.headers.get("x-document-presentation"),
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
        name,
        mime: req.headers.get("content-type") ?? "application/octet-stream",
        size: bytes.byteLength,
        sha256,
        presentation: req.headers.get("x-document-presentation") === "primary" ? "primary" : null,
      });
    },
  });
  sinkUrl = `http://localhost:${server.port}/api/runs/run_x/events`;
  documentsUrl = `http://localhost:${server.port}/api/runs/run_x/documents`;
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

function makeUploader(publishedKeys: Set<string>, overrides?: Partial<RunDocumentUploaderDeps>) {
  return createRunDocumentUploader({
    sinkUrl,
    sinkSecret: SECRET,
    workspace,
    publishedKeys,
    publishedSourceHashes: new Map(),
    // No real backoff waits in tests; retry-specific cases inject a recorder.
    sleepFn: async () => {},
    ...overrides,
  });
}

/** The dedup key the uploader records: `${sha256}:${name}`. */
function key(sha256: string, name: string): string {
  return `${sha256}:${name}`;
}

describe("createRunDocumentUploader", () => {
  it("streams a workspace file to /documents and records its sha", async () => {
    const bytes = new TextEncoder().encode("<html>hello</html>");
    await writeFile(path.join(workspace, "report.html"), bytes);
    const keys = new Set<string>();

    const doc = await makeUploader(keys)("report.html");

    expect(doc.name).toBe("report.html");
    expect(doc.size).toBe(bytes.byteLength);
    expect(doc.sha256).toBe(sha256Hex(bytes));
    expect(doc.uri).toBe(`document://${doc.id}`);
    expect(doc.presentation).toBeNull();
    expect(keys.has(key(doc.sha256, doc.name))).toBe(true);
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

  it("forwards the primary presentation intent and returns the stored role", async () => {
    await writeFile(path.join(workspace, "final.html"), "<h1>Final</h1>");

    const doc = await makeUploader(new Set())("final.html", undefined, "primary");

    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.presentation).toBe("primary");
    expect(doc.presentation).toBe("primary");
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
    const keys = new Set<string>();

    const doc = await makeUploader(keys)("r.txt");

    expect(doc.sha256).toBe(sha256Hex(bytes));
    expect(config.received).toHaveLength(2); // one failed + one successful attempt
    expect(keys.has(key(doc.sha256, doc.name))).toBe(true);
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

  it("throws a typed UploadError classifying the HTTP status", async () => {
    // 413 → file_too_large, 403 → quota_exceeded, 409 → conflict; a 500 that
    // survives all retries → upload_failed.
    await writeFile(path.join(workspace, "f.txt"), new TextEncoder().encode("x"));
    const cases: Array<[number, UploadFailureCode]> = [
      [413, "file_too_large"],
      [403, "quota_exceeded"],
      [409, "conflict"],
    ];
    for (const [status, code] of cases) {
      config = { status, statusQueue: [], received: [] };
      const err = await makeUploader(new Set())("f.txt").catch((e) => e);
      expect(err).toBeInstanceOf(UploadError);
      expect((err as UploadError).code).toBe(code);
    }
    config = { status: 500, statusQueue: [], received: [] };
    const err = await makeUploader(new Set())("f.txt").catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe("upload_failed");
  });

  it("round-trips a NON-ASCII document name to the server, byte for byte", async () => {
    // The nominal case on a French/international product. Before the header was
    // percent-encoded: the CJK and emoji names made `Headers` throw INSIDE the
    // fetch try, which the retry loop read as a network fault (3 attempts,
    // backoff, deliverable permanently lost as `upload_failed`); the accented
    // name went out UTF-8 and came back Latin-1, so `rapport-Ã©tÃ©.md` is what
    // got stored, listed in the UI and served in `Content-Disposition`.
    const names = ["报告.md", "rapport-été.md", "\u{1f4ca}.png"];
    for (const name of names) {
      config = { status: 201, statusQueue: [], received: [] };
      await writeFile(path.join(workspace, name), new TextEncoder().encode(`bytes-of-${name}`));
      const keys = new Set<string>();

      const doc = await makeUploader(keys)(name);

      expect(doc.name).toBe(name);
      expect(config.received).toHaveLength(1);
      expect(config.received[0]!.name).toBe(name);
      expect(keys.has(key(doc.sha256, name))).toBe(true);
      // The value that actually travelled is pure ASCII and is not the raw name.
      const raw = config.received[0]!.rawHeader;
      expect(raw).not.toBe(name);
      expect([...raw].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    }
  });

  it("leaves a plain ASCII name unchanged on the wire", async () => {
    await writeFile(path.join(workspace, "report.html"), new TextEncoder().encode("<b>ok</b>"));
    await makeUploader(new Set())("report.html");
    expect(config.received[0]!.rawHeader).toBe("report.html");
  });

  it("fails immediately on a directory, without a single upload attempt", async () => {
    // `publish_document({ path: "outputs" })` used to stream a directory,
    // fail opaquely, and burn 3 attempts plus backoff before reporting
    // `upload_failed`.
    await mkdir(path.join(workspace, "outputs"), { recursive: true });
    await expect(makeUploader(new Set())("outputs")).rejects.toThrow(/not a regular file/);
    expect(config.received).toHaveLength(0);
  });
});

describe("createRunArchivePublisher", () => {
  it("publishes a ZIP with canonical relative paths and removes the temporary file", async () => {
    await mkdir(path.join(workspace, "package", "src"), { recursive: true });
    await writeFile(path.join(workspace, "package", "manifest.json"), '{"type":"mcp-server"}');
    await writeFile(path.join(workspace, "package", "src", "main.js"), "export default 1;");

    let temporaryPath = "";
    let uploadedBytes = new Uint8Array();
    const publisher = createRunArchivePublisher({
      workspace,
      uploader: async (relPath, name, presentation) => {
        temporaryPath = path.join(workspace, relPath);
        uploadedBytes = new Uint8Array(await readFile(temporaryPath));
        return {
          id: "doc_archive",
          uri: "document://doc_archive",
          name: name ?? "archive.zip",
          mime: "application/zip",
          size: uploadedBytes.byteLength,
          sha256: sha256Hex(uploadedBytes),
          presentation: presentation ?? null,
        };
      },
    });

    const doc = await publisher(
      ["package/src/../manifest.json", "package/src/main.js"],
      "server.afps",
      "primary",
    );

    expect(doc.name).toBe("server.afps");
    expect(doc.presentation).toBe("primary");
    expect(Object.keys(unzipArtifact(uploadedBytes))).toEqual([
      "package/manifest.json",
      "package/src/main.js",
    ]);
    await expect(readFile(temporaryPath)).rejects.toThrow();
  });

  it("refuses directories and archives above the configured source-byte limit", async () => {
    await mkdir(path.join(workspace, "folder"), { recursive: true });
    await writeFile(path.join(workspace, "large.bin"), new Uint8Array([1, 2, 3]));
    let uploadCalls = 0;
    const publisher = createRunArchivePublisher({
      workspace,
      maxArchiveBytes: 2,
      uploader: async () => {
        uploadCalls++;
        throw new Error("must not upload");
      },
    });

    await expect(publisher(["folder"])).rejects.toThrow(/not a regular file/);
    await expect(publisher(["large.bin"])).rejects.toThrow(/sources exceed/);
    expect(uploadCalls).toBe(0);
  });
});

describe("X-Document-Name decoding (server contract)", () => {
  /** POST straight to the documents endpoint with hand-built headers. */
  async function postWithNameHeader(headerValue: string): Promise<Response> {
    return fetch(documentsUrl, {
      method: "POST",
      headers: {
        ...sign({
          msgId: randomUUID(),
          timestampSec: Math.floor(Date.now() / 1000),
          body: "",
          secret: SECRET,
        }),
        "Content-Type": "text/markdown",
        "X-Document-Name": headerValue,
      },
      body: "# hello",
    });
  }

  it("rejects a RAW (un-encoded) name with a typed 400 instead of guessing", async () => {
    // Latin-1-representable, so `Headers` happily sends it: this is exactly the
    // value that used to be stored mojibaked. Guessing an encoding here would
    // silently corrupt the deliverable's name, so the server refuses.
    const res = await postWithNameHeader("rapport-été.md");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { param: string } };
    expect(body.error.param).toBe("X-Document-Name");
    expect(config.received).toHaveLength(0);
  });

  it("rejects a malformed percent-escape with a typed 400", async () => {
    for (const bad of ["%E4%", "%zz.md", "truncated%"]) {
      const res = await postWithNameHeader(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { param: string } };
      expect(body.error.param).toBe("X-Document-Name");
    }
    expect(config.received).toHaveLength(0);
  });

  it("accepts a properly encoded name", async () => {
    const res = await postWithNameHeader(encodeURIComponent("rapport-été.md"));
    expect(res.status).toBe(200);
    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("rapport-été.md");
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
    const keys = new Set<string>();
    const events: Array<Record<string, unknown>> = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "document.published")).toBe(true);
    expect(events.every((e) => e.presentation === null)).toBe(true);
    expect(config.received.every((r) => r.presentation === null)).toBe(true);
    expect(result.published).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    // Every emitted doc's `${sha}:${name}` key is now tracked.
    for (const e of events) expect(keys.has(key(e.sha256 as string, e.name as string))).toBe(true);
  });

  it("publishes two same-content files with DIFFERENT names (keyed on sha+name)", async () => {
    // Identical bytes, distinct basenames → distinct `${sha}:${name}` keys, so
    // BOTH must publish (the old sha-only dedup would have dropped the second).
    await seedOutput("first.txt", "same-bytes");
    await seedOutput("second.txt", "same-bytes");
    const keys = new Set<string>();
    const events: Array<Record<string, unknown>> = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(2);
    expect(result.published).toHaveLength(2);
    const names = config.received.map((r) => r.name).sort();
    expect(names).toEqual(["first.txt", "second.txt"]);
  });

  it("skips a file whose sha+name was already published (dedup)", async () => {
    await seedOutput("dup.txt", "already-published");
    const sha = sha256Hex(new TextEncoder().encode("already-published"));
    const keys = new Set<string>([key(sha, "dup.txt")]);
    const events: unknown[] = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(result.skipped).toEqual([{ name: "dup.txt", reason: "already_published" }]);
  });

  it("does not sweep an unchanged output already published under a display name", async () => {
    await seedOutput("report.html", "same-deliverable");
    const keys = new Set<string>();
    const sourceHashes = new Map<string, string>();
    const events: unknown[] = [];
    const uploader = makeUploader(keys, { publishedSourceHashes: sourceHashes });

    const published = await uploader("outputs/report.html", "Quarterly overview", "primary");
    const result = await sweepOutputs({
      uploader,
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: sourceHashes,
      maxFileBytes: 1024,
      emit: (event) => {
        events.push(event);
      },
    });

    expect(published.name).toBe("Quarterly overview");
    expect(config.received).toHaveLength(1);
    expect(events).toHaveLength(0);
    expect(result.published).toHaveLength(0);
    expect(result.skipped).toEqual([{ name: "report.html", reason: "already_published" }]);
  });

  it("sweeps final bytes when an explicitly published output changed", async () => {
    await seedOutput("report.html", "draft");
    const keys = new Set<string>();
    const sourceHashes = new Map<string, string>();
    const uploader = makeUploader(keys, { publishedSourceHashes: sourceHashes });

    await uploader("outputs/report.html", "Quarterly overview", "primary");
    await seedOutput("report.html", "final");
    const result = await sweepOutputs({
      uploader,
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: sourceHashes,
      maxFileBytes: 1024,
      emit: () => {},
    });

    expect(config.received).toHaveLength(2);
    expect(config.received[1]!.name).toBe("report.html");
    expect(result.published).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips a symlink under outputs/ with a warning and publishes regular files", async () => {
    // outputs/ holds one real file + one symlink to an outside target. The
    // sweep must publish the real file and skip the symlink with a warning —
    // never following it to the outside target (`lstat`, not `stat`).
    const outside = await mkdtemp(path.join(tmpdir(), "publish-outside-"));
    await writeFile(path.join(outside, "secret.txt"), new TextEncoder().encode("secret"));
    await seedOutput("real.txt", "real-content");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "outputs", "link.txt"));

    const keys = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
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
    expect(result.skipped.some((s) => s.reason === "symlink" && s.name === "link.txt")).toBe(true);
  });

  it("records an oversized file as a lost deliverable (never throws)", async () => {
    await seedOutput("huge.txt", "0123456789");
    const warnings: string[] = [];

    const result = await sweepOutputs({
      uploader: makeUploader(new Set()),
      workspace,
      publishedKeys: new Set(),
      publishedSourceHashes: new Map(),
      maxFileBytes: 4,
      emit: () => {},
      logWarn: (m) => warnings.push(m),
    });

    expect(config.received).toHaveLength(0);
    expect(warnings.some((w) => /oversized/.test(w))).toBe(true);
    expect(result.skipped).toEqual([{ name: "huge.txt", reason: "oversized" }]);
    // The summary PROMOTES an oversized skip to a `file_too_large` failure.
    const summary = summarizeArtifacts(result);
    expect(summary.status).toBe("partial");
    expect(summary.failed).toEqual([{ name: "huge.txt", code: "file_too_large" }]);
  });

  it("returns an empty result when outputs/ does not exist", async () => {
    const events: unknown[] = [];
    const result = await sweepOutputs({
      uploader: makeUploader(new Set()),
      workspace,
      publishedKeys: new Set(),
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });
    expect(events).toHaveLength(0);
    expect(result).toEqual({ published: [], skipped: [], failed: [] });
    expect(summarizeArtifacts(result).status).toBe("complete");
  });

  it("collects a per-file upload failure with its typed code, never blocking finalize", async () => {
    // Three files; the middle one's upload fails every attempt (500 → abandoned
    // as upload_failed). The other two publish; the failure is COLLECTED, not
    // swallowed, and the sweep still resolves.
    await seedOutput("ok-1.txt", "one");
    await seedOutput("boom.txt", "boom");
    await seedOutput("ok-2.txt", "two");
    const failSha = sha256Hex(new TextEncoder().encode("boom"));
    const warnings: string[] = [];
    const events: unknown[] = [];

    const result = await sweepOutputs({
      // Force ONLY boom.txt to fail: its sha maps to a 500, others succeed.
      uploader: makeUploader(new Set(), {
        fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
          const body = init?.body as ReadableStream;
          const buf = new Uint8Array(await new Response(body).arrayBuffer());
          const sha = sha256Hex(buf);
          if (sha === failSha) return new Response("boom", { status: 500 });
          const rawHeader = (init?.headers as Record<string, string>)["X-Document-Name"]!;
          const name = sanitizeFilename(decodeFilenameHeader(rawHeader)!);
          const id = `doc_${sha.slice(0, 12)}`;
          return Response.json({
            id,
            uri: `document://${id}`,
            name,
            mime: "text/plain",
            size: buf.byteLength,
            sha256: sha,
          });
        }) as unknown as typeof fetch,
      }),
      workspace,
      publishedKeys: new Set(),
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
      logWarn: (m) => warnings.push(m),
    });

    expect(result.published).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(result.failed).toEqual([
      { name: "boom.txt", code: "upload_failed", message: expect.any(String) },
    ]);
    expect(warnings.some((w) => /dropped a deliverable/.test(w))).toBe(true);

    const summary = summarizeArtifacts(result);
    expect(summary).toEqual({
      status: "partial",
      published: 2,
      failed: [{ name: "boom.txt", code: "upload_failed" }],
    });
  });

  it("skips a hidden dotfile at the root and publishes regular files", async () => {
    await seedOutput(".env", "SECRET=shh");
    await seedOutput("report.md", "# ok");
    const keys = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
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
    expect(result.skipped.some((s) => s.reason === "hidden" && s.name === ".env")).toBe(true);
    // A hidden skip is NORMAL — it is NOT a lost deliverable.
    expect(summarizeArtifacts(result).status).toBe("complete");
  });

  it("skips a file nested inside a hidden directory", async () => {
    await seedOutput(".git/config", "[core]");
    await seedOutput("data.csv", "a,b");
    const keys = new Set<string>();
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
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

  it("keys the dedup on the SANITIZED name, matching the server index", async () => {
    // `report..md` and `report.md` both sanitize to `report.md`, and the bytes
    // are identical, so by the server identity `(run_id, sha256, name)` they are
    // ONE document. Keying on the RAW basename produced two distinct container
    // keys: the second file was streamed in full (up to the per-file cap, and
    // spending the per-run upload rate-limit budget) only for the server's
    // partial unique index to hand back the document it already had.
    await seedOutput("report.md", "same-bytes");
    await seedOutput("report..md", "same-bytes");
    const keys = new Set<string>();
    const events: unknown[] = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(config.received).toHaveLength(1);
    expect(config.received[0]!.name).toBe("report.md");
    expect(events).toHaveLength(1);
    expect(result.published).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(["already_published"]);
    expect(keys).toEqual(
      new Set([key(sha256Hex(new TextEncoder().encode("same-bytes")), "report.md")]),
    );
  });

  it("publishes a NON-ASCII output file under its exact name", async () => {
    await seedOutput("rapport-été.md", "# resultats");
    const keys = new Set<string>();
    const events: Array<Record<string, unknown>> = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(result.failed).toHaveLength(0);
    expect(result.published).toHaveLength(1);
    expect(config.received[0]!.name).toBe("rapport-été.md");
    expect(events[0]!.name).toBe("rapport-été.md");
  });

  it("keeps a document published when emitting its event fails", async () => {
    // The upload succeeded: the bytes are stored, hashed and counted against
    // the org quota server-side. When the emit sat inside the upload's try, a
    // failing sink rolled the dedup key back and recorded the file as `failed`,
    // i.e. a false negative in the artifacts summary plus a re-upload of a
    // document that is already durable.
    await seedOutput("deliverable.md", "# done");
    const keys = new Set<string>();
    const warnings: string[] = [];

    const result = await sweepOutputs({
      uploader: makeUploader(keys),
      workspace,
      publishedKeys: keys,
      publishedSourceHashes: new Map(),
      maxFileBytes: 1024,
      emit: () => {
        throw new Error("sink unreachable");
      },
      logWarn: (m) => warnings.push(m),
    });

    expect(config.received).toHaveLength(1);
    expect(result.published).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(summarizeArtifacts(result).status).toBe("complete");
    // The dedup key is RETAINED, so a later pass will not re-upload it.
    expect(keys.size).toBe(1);
    expect(warnings.some((w) => /could not emit/.test(w))).toBe(true);
  });
});

describe("summarizeArtifacts bounds (server ingest contract)", () => {
  it("clamps a runaway failed list to 1000 entries and truncates long name/code", () => {
    const failed = Array.from({ length: 1500 }, (_, i) => ({
      name: "x".repeat(600) + `-${i}`,
      code: "y".repeat(100) as UploadFailureCode,
      message: "boom",
    }));
    const summary = summarizeArtifacts({ published: [], skipped: [], failed });

    // failed sliced to the 1000-entry cap.
    expect(summary.failed).toHaveLength(1000);
    // status/published reflect the FULL result (partial because >0 lost).
    expect(summary.status).toBe("partial");
    expect(summary.published).toBe(0);
    // Each entry's name ≤512 and code ≤64.
    expect(summary.failed[0]!.name.length).toBe(512);
    expect(summary.failed[0]!.code.length).toBe(64);
    expect(summary.failed.every((f) => f.name.length <= 512 && f.code.length <= 64)).toBe(true);
  });

  it("leaves a small summary untouched", () => {
    const summary = summarizeArtifacts({
      published: [{ name: "a.txt", sha256: "s", size: 1 }],
      skipped: [],
      failed: [{ name: "b.txt", code: "upload_failed", message: "m" }],
    });
    expect(summary).toEqual({
      status: "partial",
      published: 1,
      failed: [{ name: "b.txt", code: "upload_failed" }],
    });
  });
});

describe("buildPublishDocumentDef (publish_document tool)", () => {
  it("uploads and emits a document.published event on success", async () => {
    await writeFile(path.join(workspace, "out.html"), new TextEncoder().encode("<h1>ok</h1>"));
    const def = buildPublishDocumentDef(makeUploader(new Set()));

    const result = await def.handler({ path: "out.html", presentation: "primary" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Published");
    const events = (result._meta?.["dev.appstrate/events"] ?? []) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("document.published");
    expect(events[0]!.document_id).toMatch(/^doc_/);
    expect(events[0]!.presentation).toBe("primary");
    expect(config.received[0]!.presentation).toBe("primary");
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

  it("returns a tool error for an unsupported presentation role", async () => {
    const def = buildPublishDocumentDef(makeUploader(new Set()));
    const result = await def.handler({ path: "out.html", presentation: "thumbnail" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must be `primary`");
    expect(config.received).toHaveLength(0);
  });

  it("leads its description with the publish-now + `document://` URI value", () => {
    // The `outputs/` sweep is unconditional and shares the same uploader, so
    // what the tool alone can do is publish DURING the run and hand back the
    // durable URI. A description that reads "use this tool only to publish a
    // deliverable that lives elsewhere" names the one replaceable case and
    // hides that one, so an agent never calls it at the right moment.
    const description = buildPublishDocumentDef(makeUploader(new Set())).descriptor.description!;

    expect(description).toContain("document://");
    expect(description.indexOf("document://")).toBeLessThan(description.indexOf("./outputs/"));
    expect(description).not.toContain("use this tool only");
    expect(description).toContain("finish editing it first");
    expect(description).toContain("last successful primary publication");
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
