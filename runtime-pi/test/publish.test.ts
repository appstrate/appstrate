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
import { createRunDocumentUploader, sweepOutputs } from "../publish.ts";

const SECRET = "test-run-secret-0123456789";

interface Received {
  name: string | null;
  contentType: string | null;
  sha256: string;
  size: number;
}

interface ServerConfig {
  /** HTTP status to answer with (2xx → success JSON, else error). */
  status: number;
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
      if (config.status < 200 || config.status >= 300) {
        return new Response(`error ${config.status}`, { status: config.status });
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
  config = { status: 201, received: [] };
  // `realpath`: on macOS `tmpdir()` (`/var/folders/…`) is a symlink to
  // `/private/var/folders/…`. `resolveSafeFile` canonicalizes the workspace
  // root before comparing resolved paths to it, so an unresolved root makes
  // every path look like a symlink escape. Real runs mount a real directory;
  // only the fixture needs this.
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), "publish-test-")));
});

function makeUploader(publishedShas: Set<string>) {
  return createRunDocumentUploader({ sinkUrl, sinkSecret: SECRET, workspace, publishedShas });
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

  it("rejects a path escaping the workspace", async () => {
    await expect(makeUploader(new Set())("../secret.txt")).rejects.toThrow(
      /outside the allowed roots/,
    );
  });

  it("rejects a symlink pointing outside the workspace, uploading nothing", async () => {
    // A symlink INSIDE the workspace whose target sits outside it: a lexical
    // guard would pass (the link path is under the workspace), but the file
    // it resolves to is not — `resolveSafeFile` refuses it via its lstat gate.
    const outside = await mkdtemp(path.join(tmpdir(), "publish-outside-"));
    await writeFile(path.join(outside, "secret.txt"), new TextEncoder().encode("secret"));
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));

    await expect(makeUploader(new Set())("link.txt")).rejects.toThrow();
    expect(config.received).toHaveLength(0);
  });

  it("surfaces a non-2xx response as an error", async () => {
    config.status = 413;
    await writeFile(path.join(workspace, "big.txt"), new TextEncoder().encode("x"));
    await expect(makeUploader(new Set())("big.txt")).rejects.toThrow(/413/);
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
    expect(warnings.some((w) => /failed to publish/.test(w))).toBe(true);
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
});
