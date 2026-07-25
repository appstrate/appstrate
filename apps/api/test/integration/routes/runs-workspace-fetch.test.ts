// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the agent self-provisioning fetches:
 *   - `GET /api/runs/:runId/workspace`         — the AFPS bundle (ZIP)
 *   - `GET /api/runs/:runId/documents`         — the input-document manifest
 *   - `GET /api/runs/:runId/documents/:name`   — one document, streamed
 *
 * The agent extracts the bundle to its workspace root and streams each input
 * document to `documents/<name>` on disk, instead of relying on a
 * seed-into-the-run-volume step whose correctness depended on the volume
 * driver — a tmpfs-backed `local` volume is not shared between the seed helper
 * and the agent container, so the bundle silently vanished and skills never
 * materialised (issue #549). Documents are stored as individual objects (not
 * bundled into the ZIP) so the agent never buffers the whole payload.
 *
 * Auth is the same Standard Webhooks HMAC as event ingestion, here over an
 * empty GET body. These tests pin: the storage round-trip (bundle + per-doc +
 * manifest), the bundle fetch (200 / 404-empty / 401-bad-sig / 410-closed /
 * 404-unknown), and the document fetches (manifest 200 / 404, doc 200 / 404).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { eq } from "drizzle-orm";
import { runs, storageDeletionJobs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  uploadRunBundle,
  streamRunDocument,
  writeRunDocumentsManifest,
  downloadRunWorkspace,
  downloadRunDocumentsManifest,
  downloadRunDocumentStream,
  deleteRunWorkspace,
} from "../../../src/services/run-workspace-storage.ts";
import { processStorageDeletionJobs } from "../../../src/services/storage-deletion.ts";
import { uploadFile as storagePut } from "@appstrate/db/storage";

const app = getTestApp();

/** Write a manifest JSON to run-workspace storage directly, bypassing the
 *  uniqueness assertion in `writeRunDocumentsManifest` — used to simulate a
 *  corrupted / hand-built manifest the serve-time guard must reject. */
async function putRawManifest(runId: string, manifest: unknown): Promise<void> {
  await storagePut(
    "run-workspace",
    `${runId}/manifest.json`,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
}

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

/**
 * Provision a run workspace the way the production trigger now does: bundle via
 * uploadRunBundle, each document streamed in, then the manifest written once.
 * Mirrors the split that lets the platform stream documents through without
 * buffering them (the bundle stays a verbatim upload).
 */
async function seedWorkspace(
  runId: string,
  upload: {
    bundle?: Buffer;
    documents: { name: string; content: Buffer; workspaceName?: string }[];
  },
): Promise<void> {
  if (upload.bundle) await uploadRunBundle(runId, upload.bundle);
  if (upload.documents.length > 0) {
    for (const doc of upload.documents) {
      await streamRunDocument(
        runId,
        doc.workspaceName ?? doc.name,
        new Response(doc.content).body!,
      );
    }
    await writeRunDocumentsManifest(
      runId,
      upload.documents.map((d) => ({
        name: d.name,
        workspace_name: d.workspaceName ?? d.name,
        size: d.content.byteLength,
      })),
    );
  }
}

function signedGetHeaders(secret: string): Record<string, string> {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  // The HMAC covers the (empty) GET body — exactly what the agent runtime signs.
  const headers = sign({ msgId, timestampSec, body: "", secret });
  return {
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRunWithSink(
  ctx: TestContext,
  packageId: string,
  overrides: { sinkClosedAt?: Date | null; sinkExpiresAt?: Date } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: overrides.sinkExpiresAt ?? new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
  });
  return runId;
}

describe("run-workspace storage round-trip", () => {
  it("uploads, downloads, and deletes the bundle + documents + manifest", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await seedWorkspace(runId, {
      bundle: Buffer.from("PACKAGE-BYTES"),
      documents: [
        { name: "report.txt", content: Buffer.from("hello world") },
        { name: "data.csv", content: Buffer.from("a,b,c") },
      ],
    });

    // Bundle: the agent-package.afps bytes, stored verbatim.
    const archive = await downloadRunWorkspace(runId);
    expect(archive).not.toBeNull();
    expect(new TextDecoder().decode(new Uint8Array(archive!))).toBe("PACKAGE-BYTES");

    // Manifest enumerates the documents with their sizes.
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toEqual([
      { name: "report.txt", workspace_name: "report.txt", size: 11 },
      { name: "data.csv", workspace_name: "data.csv", size: 5 },
    ]);

    // Each document is fetchable as its own streamed object.
    const reportStream = await downloadRunDocumentStream(runId, "report.txt");
    expect(reportStream).not.toBeNull();
    expect(await new Response(reportStream!).text()).toBe("hello world");

    // deleteRunWorkspace now enqueues the purge into the transactional deletion
    // outbox (all keys in one tx — no silent orphan); the worker performs the
    // physical deletes. Drain it, then the objects are gone.
    await deleteRunWorkspace(runId);
    await processStorageDeletionJobs();
    expect(await downloadRunWorkspace(runId)).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    expect(await downloadRunDocumentStream(runId, "report.txt")).toBeNull();
  });

  it("uploads only a bundle when there are no documents (no manifest)", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await seedWorkspace(runId, { bundle: Buffer.from("BUNDLE"), documents: [] });
    expect(await downloadRunWorkspace(runId)).not.toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    await deleteRunWorkspace(runId);
  });

  it("writes nothing with no bundle and no documents", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await seedWorkspace(runId, { documents: [] });
    expect(await downloadRunWorkspace(runId)).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
  });

  it("deleteRunWorkspace never throws on a missing object", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await deleteRunWorkspace(runId); // must not throw
    expect(await downloadRunWorkspace(runId)).toBeNull();
  });

  it("enqueues the whole teardown even when reading the manifest fails, and the worker finishes it", async () => {
    // Own the outbox for this test: the round-trip cases above leave their own
    // pending jobs behind (this describe block has no per-test reset).
    await truncateAll();
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await seedWorkspace(runId, {
      bundle: Buffer.from("BUNDLE"),
      documents: [
        { name: "a.txt", content: Buffer.from("aaa") },
        { name: "b.txt", content: Buffer.from("bbb") },
      ],
    });

    await deleteRunWorkspace(runId);

    // Teardown does NO storage read: both keys are durably queued straight away.
    // (It used to download the manifest first to derive the document keys — a
    // transient 503 there enqueued NOTHING at all, and since the run is terminal
    // nothing ever revisited it: the bytes were orphaned forever.)
    const queued = await db
      .select({ storageKey: storageDeletionJobs.storageKey })
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.bucket, "run-workspace"));
    expect(new Set(queued.map((j) => j.storageKey))).toEqual(
      new Set([`${runId}.afps`, `${runId}/manifest.json`]),
    );

    // The manifest expansion now lives in the WORKER, where a failed read is a
    // retry — not a silent loss. The documents survive this pass untouched.
    const failedPass = await processStorageDeletionJobs({
      downloadFile: async () => {
        throw new Error("storage 503 while reading the manifest");
      },
    });
    expect(failedPass.failed).toBe(1);
    expect(await downloadRunDocumentStream(runId, "a.txt")).not.toBeNull();
    const [pending] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, `${runId}/manifest.json`));
    expect(pending!.completedAt).toBeNull();
    expect(pending!.lastError).toContain("503");

    // Once storage recovers (lease/backoff elapsed), the retry purges everything.
    // Backdated rather than stamped "now" so the row is due whatever the API↔DB
    // clock skew.
    await db
      .update(storageDeletionJobs)
      .set({ nextAttemptAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(storageDeletionJobs.storageKey, `${runId}/manifest.json`));
    await processStorageDeletionJobs();
    expect(await downloadRunWorkspace(runId)).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    expect(await downloadRunDocumentStream(runId, "a.txt")).toBeNull();
    expect(await downloadRunDocumentStream(runId, "b.txt")).toBeNull();
  });
});

describe("GET /api/runs/:runId/workspace", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "ws@test.dev", orgSlug: "ws-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/ws-agent", type: "agent" });
  });

  it("returns the provisioned bundle to a signed request", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    await seedWorkspace(runId, { bundle: Buffer.from("BUNDLE"), documents: [] });

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(await res.text()).toBe("BUNDLE");

    await deleteRunWorkspace(runId);
  });

  it("returns 404 when no bundle was provisioned", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid signature with 401", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    await seedWorkspace(runId, { bundle: Buffer.from("BUNDLE"), documents: [] });

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders("wrong-secret-".repeat(3)),
    });
    expect(res.status).toBe(401);

    await deleteRunWorkspace(runId);
  });

  it("rejects a closed sink with 410", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent", { sinkClosedAt: new Date() });
    await seedWorkspace(runId, { bundle: Buffer.from("BUNDLE"), documents: [] });

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(410);

    await deleteRunWorkspace(runId);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await app.request(`/api/runs/run_does_not_exist/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/runs/:runId/documents[/:name]", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "docs@test.dev", orgSlug: "docs-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/docs-agent", type: "agent" });
  });

  it("returns the manifest then streams each document", async () => {
    const runId = await seedRunWithSink(ctx, "@test/docs-agent");
    await seedWorkspace(runId, {
      bundle: Buffer.from("BUNDLE"),
      documents: [{ name: "a.txt", content: Buffer.from("doc-a") }],
    });

    const manifestRes = await app.request(`/api/runs/${runId}/documents`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(manifestRes.status).toBe(200);
    expect(await manifestRes.json()).toEqual({
      documents: [{ name: "a.txt", workspace_name: "a.txt", size: 5 }],
    });

    const docRes = await app.request(`/api/runs/${runId}/documents/a.txt`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(docRes.status).toBe(200);
    expect(docRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(await docRes.text()).toBe("doc-a");

    await deleteRunWorkspace(runId);
  });

  it("rejects a malformed manifest with duplicate workspace names (400 duplicate_document_name)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/docs-agent");
    // A corrupted / hand-built manifest whose two entries resolve to the SAME
    // workspace_name would silently overwrite one document with the other in the
    // container. The platform never produces one, so this bypasses the write
    // guard by putting the JSON in storage directly — the serve-time guard must
    // reject it with a typed 400 (which the runtime then treats as fatal).
    await putRawManifest(runId, {
      documents: [
        { name: "report.pdf", workspace_name: "report.pdf", size: 3 },
        { name: "other.pdf", workspace_name: "report.pdf", size: 4 },
      ],
    });

    const res = await app.request(`/api/runs/${runId}/documents`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("duplicate_document_name");

    await deleteRunWorkspace(runId);
  });

  it("returns 404 on the manifest when the run carries no documents", async () => {
    const runId = await seedRunWithSink(ctx, "@test/docs-agent");
    await seedWorkspace(runId, { bundle: Buffer.from("BUNDLE"), documents: [] });

    const res = await app.request(`/api/runs/${runId}/documents`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);

    await deleteRunWorkspace(runId);
  });

  it("returns 404 for a document the run does not have", async () => {
    const runId = await seedRunWithSink(ctx, "@test/docs-agent");
    await seedWorkspace(runId, {
      bundle: Buffer.from("BUNDLE"),
      documents: [{ name: "a.txt", content: Buffer.from("doc-a") }],
    });

    const res = await app.request(`/api/runs/${runId}/documents/missing.txt`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);

    await deleteRunWorkspace(runId);
  });

  it("rejects an invalid signature with 401", async () => {
    const runId = await seedRunWithSink(ctx, "@test/docs-agent");
    await seedWorkspace(runId, {
      bundle: Buffer.from("BUNDLE"),
      documents: [{ name: "a.txt", content: Buffer.from("doc-a") }],
    });

    const res = await app.request(`/api/runs/${runId}/documents/a.txt`, {
      method: "GET",
      headers: signedGetHeaders("wrong-secret-".repeat(3)),
    });
    expect(res.status).toBe(401);

    await deleteRunWorkspace(runId);
  });
});
