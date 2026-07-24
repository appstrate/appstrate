// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-backend parity for the documents lifecycle.
 *
 * The upload → materialize → download → delete → purge flow must behave
 * identically across the three storage postures:
 *
 *   - **filesystem** (tier0, always) and **S3 proxy-stream** (tier3, ambient) —
 *     the same code path exercised by the "core flow" block below; whichever
 *     backend the tier provides is the one under test, so a single run covers
 *     FS on tier0 and S3-proxy on tier3.
 *   - **S3 presigned** (tier3, gated + toggled) — the `S3_PUBLIC_ENDPOINT`
 *     posture, where `GET /content` 307-redirects to a presigned URL instead of
 *     proxy-streaming. This is the regression guard for the bug where the MCP
 *     read path followed that 307 and broke: the MCP `resources/read` reads the
 *     bytes straight from storage (`streamDocumentContent`), so it returns bytes
 *     on presigned deployments too. Also covers the client-declared-sha256
 *     presigned PUT (MinIO verifies the checksum server-side).
 *
 * The presigned block flips the process-global store into presigned mode
 * (`S3_PUBLIC_ENDPOINT` + store/env cache reset) and restores it after, so it
 * never leaks the posture to sibling files.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { uploads, storageDeletionJobs } from "@appstrate/db/schema";
import {
  uploadStream,
  downloadFile,
  fileExists,
  createUploadUrl,
  _resetStoreForTesting,
} from "@appstrate/db/storage";
import { _resetCacheForTesting } from "@appstrate/env";
import type { Actor } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { describeRequiresS3 } from "../../helpers/tier.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import {
  createDocumentFromUpload,
  createDocumentFromStream,
  parseStorageKey,
} from "../../../src/services/documents.ts";
import { processStorageDeletionJobs } from "../../../src/services/storage-deletion.ts";
import { deleteDocument } from "../../../src/services/documents.ts";
import {
  buildDocumentResourceProvider,
  type McpToolContext,
} from "../../../src/modules/mcp/tools.ts";
import { runs } from "@appstrate/db/schema";

type Scope = { orgId: string; applicationId: string };
const app = getTestApp();

async function stageUpload(
  scope: Scope,
  createdBy: string | null,
  name: string,
  bytes: Uint8Array,
  mime = "text/plain",
): Promise<string> {
  const up = await createUpload({
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    createdBy,
    name,
    size: bytes.byteLength,
    mime,
  });
  const [row] = await db
    .select({ storageKey: uploads.storageKey })
    .from(uploads)
    .where(eq(uploads.id, up.id));
  const [bucket, ...rest] = row!.storageKey.split("/");
  await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
  return up.id;
}

async function seedRunRow(scope: Scope): Promise<string> {
  const id = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: "test-sink-secret",
    sinkExpiresAt: new Date(Date.now() + 3_600_000),
    startedAt: new Date(),
  });
  return id;
}

function publishStream(scope: Scope, runId: string, name: string, content: string) {
  return createDocumentFromStream(scope, runId, { userId: null, endUserId: null }, null, {
    name,
    mime: "text/plain",
    body: new Blob([new TextEncoder().encode(content)]).stream(),
  });
}

// ── Core flow parity — runs under the AMBIENT backend (FS tier0, S3-proxy tier3) ──
describe("documents storage parity — core flow (ambient backend)", () => {
  let ctx: TestContext;
  let scope: Scope;
  let userActor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "storagematrix" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    userActor = { type: "user", id: ctx.user.id };
  });

  it("upload → materialize → download → delete → outbox purge round-trips on the active backend", async () => {
    const bytes = new TextEncoder().encode("parity payload bytes");
    const runId = await seedRunRow(scope);
    const uploadId = await stageUpload(scope, ctx.user.id, "parity.txt", bytes);

    // Materialize the staged upload into a durable document.
    const doc = await createDocumentFromUpload(scope, userActor, uploadId, { runId });
    const parsed = parseStorageKey(doc.storageKey)!;
    expect(await fileExists(parsed.bucket, parsed.path)).toBe(true);

    // Download the bytes through the API proxy route (200 on FS + S3-proxy;
    // the presigned posture is covered separately below).
    const content = await app.request(`/api/documents/${doc.id}/content`, {
      headers: authHeaders(ctx),
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("parity payload bytes");

    // Delete enqueues an outbox job atomically; the object is still present
    // until the worker runs.
    await deleteDocument(scope, doc.id);
    expect(await fileExists(parsed.bucket, parsed.path)).toBe(true);
    const pending = await db
      .select()
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));
    expect(pending).toHaveLength(1);

    // One worker pass purges the object and completes the job — same on every
    // backend (deleteFile is idempotent on a missing object).
    const pass = await processStorageDeletionJobs();
    expect(pass.completed).toBe(1);
    expect(await fileExists(parsed.bucket, parsed.path)).toBe(false);
    const stillPending = await db
      .select()
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));
    expect(stillPending).toHaveLength(0);
  });
});

// ── S3 presigned posture — gated on MinIO + toggled into publicEndpoint mode ──
describeRequiresS3("documents storage parity — S3 presigned posture", () => {
  let ctx: TestContext;
  let scope: Scope;
  let prevPublicEndpoint: string | undefined;

  beforeAll(() => {
    // Flip the process-global store into direct-presign mode by pointing the
    // public endpoint at the same MinIO the test process can reach.
    prevPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    _resetCacheForTesting();
    _resetStoreForTesting();
  });

  afterAll(() => {
    if (prevPublicEndpoint === undefined) delete process.env.S3_PUBLIC_ENDPOINT;
    else process.env.S3_PUBLIC_ENDPOINT = prevPublicEndpoint;
    _resetCacheForTesting();
    _resetStoreForTesting();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "presigned" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
  });

  it("GET /content 307-redirects to a presigned URL that serves the bytes from MinIO", async () => {
    const runId = await seedRunRow(scope);
    const published = await publishStream(scope, runId, "deliverable.txt", "presigned bytes ok");

    const res = await app.request(`/api/documents/${published.row.id}/content`, {
      headers: authHeaders(ctx),
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    // An agent_output download implies metadata → the digest rides the redirect.
    expect(res.headers.get("Repr-Digest")).toBeTruthy();
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();

    // The presigned Location works against MinIO directly (bytes, not a 307 loop).
    const followed = await fetch(location!);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toBe("presigned bytes ok");
  });

  it("MCP resources/read still returns the bytes on the presigned posture (307-regression guard)", async () => {
    const runId = await seedRunRow(scope);
    const published = await publishStream(scope, runId, "mcp-read.txt", "mcp reads bytes directly");

    const mcpCtx: McpToolContext = {
      origin: "https://instance.example",
      authHeaders: new Headers(),
      permissions: new Set<string>(),
      actor: { type: "user", id: ctx.user.id },
      scope,
      dispatch: async () => new Response(null),
    };
    const read = await buildDocumentResourceProvider(mcpCtx).read(
      `document://${published.row.id}`,
      {} as Parameters<ReturnType<typeof buildDocumentResourceProvider>["read"]>[1],
    );
    // Bytes inlined as text — NOT a 307 the reader cannot follow, NOT metadata-only.
    const block = read.contents[0] as { mimeType?: string; text?: string };
    expect(block.mimeType).toBe("text/plain");
    expect(block.text).toBe("mcp reads bytes directly");
  });

  it("presigned PUT with x-amz-checksum-sha256: MinIO accepts a matching body, rejects a mismatch (4xx)", async () => {
    const bytes = new TextEncoder().encode("checksum-guarded upload body");
    const sha256hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const key = `checksum-test/${crypto.randomUUID()}/file.bin`;

    // The presigned descriptor binds the sha256 into the signature + returns the
    // header the client must echo.
    const descriptor = await createUploadUrl("uploads", key, { sha256: sha256hex });
    expect(descriptor.headers["x-amz-checksum-sha256"]).toBeTruthy();

    // Matching body → MinIO verifies the checksum server-side and accepts.
    const ok = await fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      body: bytes,
    });
    expect(ok.status).toBe(200);

    // Same signed checksum header, DIFFERENT body → MinIO recomputes the digest,
    // sees the mismatch, and rejects with a 4xx of its own (BadDigest).
    const tampered = new TextEncoder().encode("tampered upload body");
    const key2 = `checksum-test/${crypto.randomUUID()}/file.bin`;
    const descriptor2 = await createUploadUrl("uploads", key2, { sha256: sha256hex });
    const bad = await fetch(descriptor2.url, {
      method: "PUT",
      headers: descriptor2.headers,
      body: tampered,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it("presigned PUT is create-only: replay cannot replace the first payload", async () => {
    const first = new TextEncoder().encode("immutable first payload");
    const replay = new TextEncoder().encode("replayed replacement!!!");
    expect(replay.byteLength).toBe(first.byteLength);
    const key = `replay-test/${crypto.randomUUID()}/file.bin`;
    const descriptor = await createUploadUrl("uploads", key, {
      maxSize: first.byteLength,
    });

    expect(descriptor.headers["If-None-Match"]).toBe("*");
    const initialPut = await fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      body: first,
    });
    expect(initialPut.status).toBe(200);

    const replayPut = await fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      body: replay,
    });
    expect(replayPut.status).toBeGreaterThanOrEqual(400);
    expect(replayPut.status).toBeLessThan(500);

    const stored = await downloadFile("uploads", key);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(stored!)).toEqual(first);
  });
});
