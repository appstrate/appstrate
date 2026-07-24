// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `parseRequestInput`'s streamed document consume — the
 * glue that pipes each staged upload straight from the uploads bucket into the
 * run workspace (no full buffer in API memory), writes the documents manifest,
 * and rolls the workspace back when a document fails validation.
 *
 * Drives `parseRequestInput` directly with a minimal fake Hono context so the
 * run-trigger pipeline (Docker, LLM) is not involved. Real Postgres + FS
 * storage.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { uploads, runs } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, addOrgMember } from "../../helpers/auth.ts";
import { parseRequestInput, isStrippedInlineMarker } from "../../../src/services/input-parser.ts";
import {
  createDocumentFromUpload,
  createDocumentFromStream,
} from "../../../src/services/documents.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  downloadRunDocumentStream,
  downloadRunDocumentsManifest,
} from "../../../src/services/run-workspace-storage.ts";
import { uploadFile as storagePut, fileExists as storageExists } from "@appstrate/db/storage";
import { ApiError } from "../../../src/lib/errors.ts";
import type { JSONSchemaObject } from "@appstrate/core/form";

const UPLOAD_BUCKET = "uploads";
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

const fileSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
  },
};

async function seedUpload(
  ctx: { orgId: string; applicationId: string },
  opts: { id: string; bytes: Buffer; mime?: string; sizeOverride?: number; name?: string },
): Promise<void> {
  const storagePath = `${ctx.applicationId}/${opts.id}/file.pdf`;
  await storagePut(UPLOAD_BUCKET, storagePath, opts.bytes);
  await db.insert(uploads).values({
    id: opts.id,
    orgId: ctx.orgId,
    applicationId: ctx.applicationId,
    createdBy: null,
    storageKey: `${UPLOAD_BUCKET}/${storagePath}`,
    name: opts.name ?? "file.pdf",
    mime: opts.mime ?? "application/pdf",
    size: opts.sizeOverride ?? opts.bytes.length,
    expiresAt: new Date(Date.now() + 900 * 1000),
  });
}

/** Minimal Hono context stub — parseRequestInput reads the JSON body, orgId/applicationId, the actor (user/endUser), and (for rerun_from) endUser. */
function fakeCtx(
  body: unknown,
  ctx: { orgId: string; applicationId: string; endUser?: { id: string }; user?: { id: string } },
): Context {
  return {
    req: { json: async () => body },
    get: (key: string) =>
      key === "orgId"
        ? ctx.orgId
        : key === "applicationId"
          ? ctx.applicationId
          : key === "endUser"
            ? ctx.endUser
            : key === "user"
              ? ctx.user
              : undefined,
  } as unknown as Context;
}

/** Insert a minimal prior-run row the rerun_from path can resolve. */
async function seedRun(
  scope: { orgId: string; applicationId: string },
  opts: { id: string; input: Record<string, unknown> | null },
): Promise<void> {
  await db.insert(runs).values({
    id: opts.id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    packageId: null,
    status: "cancelled",
    input: opts.input,
  });
}

describe("parseRequestInput — streamed document consume", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("streams the upload into the run workspace + writes the manifest", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-ok" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_ok_1";
    const storagePath = `${ctx.defaultAppId}/${id}/file.pdf`;
    await seedUpload(scope, { id, bytes: PDF_BYTES });

    const runId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: `upload://${id}` } }, scope),
      runId,
      fileSchema,
    );

    // Metadata surfaced, no buffer.
    expect(result.uploadedFiles).toHaveLength(1);
    const file = result.uploadedFiles![0]!;
    expect(file).toMatchObject({
      fieldName: "doc",
      name: "file.pdf",
      type: "application/pdf",
      size: PDF_BYTES.length,
    });
    expect("buffer" in file).toBe(false);

    // Document landed in the run workspace + manifest enumerates it.
    const docStream = await downloadRunDocumentStream(runId, "file.pdf");
    expect(docStream).not.toBeNull();
    expect(new Uint8Array(await new Response(docStream!).arrayBuffer())).toEqual(
      new Uint8Array(PDF_BYTES),
    );
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toEqual([
      { name: "file.pdf", workspace_name: "file.pdf", size: PDF_BYTES.length },
    ]);

    // Source upload stamped consumed; its storage object is RETAINED so the
    // same URI stays re-consumable for the post-consume reuse window (#634).
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).not.toBeNull();
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);
  });

  it("rolls the workspace back + releases the claim on a size mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-size" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_size_1";
    // Declared size larger than the bytes actually staged → mismatch at drain.
    await seedUpload(scope, { id, bytes: PDF_BYTES, sizeOverride: PDF_BYTES.length + 1 });

    const runId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(fakeCtx({ input: { doc: `upload://${id}` } }, scope), runId, fileSchema),
    ).rejects.toMatchObject({ status: 400 });

    // Workspace rolled back — no orphaned document or manifest.
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    // Claim released so the client can re-upload + retry.
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).toBeNull();
  });

  it("aborts mid-stream when an upload overshoots its declared size", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-overshoot" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_overshoot_1";
    // Declares 5 bytes but stages ~64 KB — the declared-small / uploaded-huge
    // abuse the early-abort guard exists for. The counter must error the stream
    // before the whole object lands in the run workspace.
    const huge = Buffer.concat([PDF_BYTES, Buffer.alloc(64 * 1024, 0x20)]);
    await seedUpload(scope, { id, bytes: huge, sizeOverride: 5 });

    const runId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(fakeCtx({ input: { doc: `upload://${id}` } }, scope), runId, fileSchema),
    ).rejects.toMatchObject({ status: 400 });

    // Workspace rolled back, claim released — same guarantees as any rejection.
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).toBeNull();
  });

  it("rolls the workspace back on a MIME mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-mime" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_mime_1";
    // Declared application/pdf, but the bytes are plain text → magic-byte sniff fails.
    await seedUpload(scope, {
      id,
      bytes: Buffer.from("not a pdf", "utf-8"),
      mime: "application/pdf",
    });

    const runId = `run_${crypto.randomUUID()}`;
    let thrown: unknown;
    try {
      await parseRequestInput(
        fakeCtx({ input: { doc: `upload://${id}` } }, scope),
        runId,
        fileSchema,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
  });
});

describe("parseRequestInput — document:// cross-actor ACL (S2)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seedRunningRun(
    scope: { orgId: string; applicationId: string },
    id: string,
  ): Promise<void> {
    await db.insert(runs).values({
      id,
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      packageId: null,
      status: "running",
    });
  }

  it("member B cannot deliver member A's user_upload into their own run (404)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-s2-upload" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const memberB = await createTestUser({ email: "b@s2.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");

    // Member A (ctx.user) materializes a run-contained user_upload.
    const runId = `run_${crypto.randomUUID()}`;
    await seedRunningRun(scope, runId);
    await seedUpload(scope, { id: "upl_s2_up", bytes: PDF_BYTES });
    const docA = await createDocumentFromUpload(
      scope,
      { type: "user", id: ctx.user.id },
      "upl_s2_up",
      { runId },
    );

    // Member B references A's private upload — org-wide run visibility resolves
    // the container, but the creator-only gate rejects it as not-found.
    const newRunId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(
        fakeCtx(
          { input: { doc: `document://${docA.id}` } },
          { ...scope, user: { id: memberB.id } },
        ),
        newRunId,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("member A CAN resolve their own user_upload", async () => {
    const ctx = await createTestContext({ orgSlug: "org-s2-own" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const runId = `run_${crypto.randomUUID()}`;
    await seedRunningRun(scope, runId);
    await seedUpload(scope, { id: "upl_s2_own", bytes: PDF_BYTES });
    const docA = await createDocumentFromUpload(
      scope,
      { type: "user", id: ctx.user.id },
      "upl_s2_own",
      { runId },
    );

    const newRunId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: `document://${docA.id}` } }, { ...scope, user: { id: ctx.user.id } }),
      newRunId,
      fileSchema,
    );
    expect(result.uploadedFiles).toHaveLength(1);
  });

  it("member B CAN resolve an agent_output of a run they can see (chaining, D6)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-s2-out" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const memberB = await createTestUser({ email: "b2@s2.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");

    const runId = `run_${crypto.randomUUID()}`;
    await seedRunningRun(scope, runId);
    const { row: agentDoc } = await createDocumentFromStream(
      scope,
      runId,
      { userId: ctx.user.id, endUserId: null },
      null,
      { name: "out.pdf", mime: "application/pdf", body: new Blob([PDF_BYTES]).stream() },
    );

    const newRunId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx(
        { input: { doc: `document://${agentDoc.id}` } },
        { ...scope, user: { id: memberB.id } },
      ),
      newRunId,
      fileSchema,
    );
    expect(result.uploadedFiles).toHaveLength(1);
  });
});

describe("parseRequestInput — rerun_from (#634)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("replays a cancelled run's upload:// input — re-consumed, rewritten to document://", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-ok" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_rerun_ok_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });

    // A prior run persisted an upload:// input (legacy / pre-materialization);
    // the upload stays re-consumable within its reuse window.
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(scope, { id: priorRunId, input: { doc: `upload://${id}` } });

    const newRunId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ rerun_from: priorRunId }, scope),
      newRunId,
      fileSchema,
    );

    // upload:// stays replayable (backward compat) — re-consumed into the new
    // workspace and rewritten to a durable document:// reference (with a pending
    // materialization the run pipeline commits once the run row exists).
    expect(result.uploadedFiles).toHaveLength(1);
    expect(result.uploadedFiles![0]).toMatchObject({
      fieldName: "doc",
      name: "file.pdf",
      size: PDF_BYTES.length,
    });
    expect(result.input!.doc as string).toStartWith("document://doc_");
    expect(result.pendingDocuments).toHaveLength(1);
    // The replayed document landed in the NEW run's workspace.
    const docStream = await downloadRunDocumentStream(newRunId, "file.pdf");
    expect(docStream).not.toBeNull();
    expect(new Uint8Array(await new Response(docStream!).arrayBuffer())).toEqual(
      new Uint8Array(PDF_BYTES),
    );
  });

  it("resolves a document:// input into the run workspace; 404 cross-org and cross-app", async () => {
    const ctx = await createTestContext({ orgSlug: "org-docref" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const actor = { type: "user" as const, id: ctx.user.id };

    // Materialize a durable document from a staged upload on a run.
    const id = "upl_docref_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      status: "running",
    });
    const doc = await createDocumentFromUpload(scope, actor, id, { runId });

    // A new run references it by document:// — resolved into the new workspace.
    const newRunId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: `document://${doc.id}` } }, { ...scope, user: { id: ctx.user.id } }),
      newRunId,
      fileSchema,
    );
    expect(result.uploadedFiles).toHaveLength(1);
    expect(result.pendingDocuments).toBeUndefined(); // document:// is not re-materialized
    const docStream = await downloadRunDocumentStream(newRunId, "file.pdf");
    expect(docStream).not.toBeNull();
    expect(new Uint8Array(await new Response(docStream!).arrayBuffer())).toEqual(
      new Uint8Array(PDF_BYTES),
    );

    // Cross-org: another org's run cannot resolve the document → 404.
    const other = await createTestContext({ orgSlug: "org-docref-other" });
    await expect(
      parseRequestInput(
        fakeCtx(
          { input: { doc: `document://${doc.id}` } },
          { orgId: other.orgId, applicationId: other.defaultAppId, user: { id: other.user.id } },
        ),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });

    // Cross-app: same org, foreign application id → 404.
    await expect(
      parseRequestInput(
        fakeCtx(
          { input: { doc: `document://${doc.id}` } },
          { orgId: ctx.orgId, applicationId: "app_not_this_one", user: { id: ctx.user.id } },
        ),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an over-quota upload input synchronously (403) BEFORE the run is created", async () => {
    const ctx = await createTestContext({ orgSlug: "org-docquota" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_docquota_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });

    // Quota below the upload's declared size → the input-parser pre-flight
    // rejects with 403 before any streaming (and, in the route, before createRun).
    const prev = process.env.ORG_STORAGE_QUOTA_BYTES;
    process.env.ORG_STORAGE_QUOTA_BYTES = String(PDF_BYTES.length - 1);
    _resetCacheForTesting();
    try {
      await expect(
        parseRequestInput(
          fakeCtx({ input: { doc: `upload://${id}` } }, { ...scope, user: { id: ctx.user.id } }),
          `run_${crypto.randomUUID()}`,
          fileSchema,
        ),
      ).rejects.toMatchObject({ status: 403, code: "storage_limit_exceeded" });
      // The upload was never consumed (rejected pre-stream) and no document exists.
      const [uploadRow] = await db.select().from(uploads).where(eq(uploads.id, id));
      expect(uploadRow!.consumedAt).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ORG_STORAGE_QUOTA_BYTES;
      else process.env.ORG_STORAGE_QUOTA_BYTES = prev;
      _resetCacheForTesting();
    }
  });

  it("rejects when both input and rerun_from are sent", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-both" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await expect(
      parseRequestInput(
        fakeCtx({ input: {}, rerun_from: "run_x" }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-string rerun_from", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-shape" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: 42 }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("hides another tenant's run behind not-found (RBAC)", async () => {
    const owner = await createTestContext({ orgSlug: "org-rerun-owner" });
    const other = await createTestContext({ orgSlug: "org-rerun-other" });
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      { id: priorRunId, input: { doc: "upload://upl_whatever1" } },
    );

    await expect(
      parseRequestInput(
        fakeCtx(
          { rerun_from: priorRunId },
          { orgId: other.orgId, applicationId: other.defaultAppId },
        ),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects replaying a different agent's run with 409 rerun_agent_mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-agent" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    // seedRun stamps packageId NULL — any concrete agent id mismatches.
    await seedRun(scope, { id: priorRunId, input: {} });

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
        {
          agentPackageId: "@acme/agent",
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "rerun_agent_mismatch" });
  });

  it("end-users cannot replay runs that are not their own", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-eu" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    // Prior run has no end-user → an end-user caller must not see it.
    await seedRun(scope, { id: priorRunId, input: {} });

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, { ...scope, endUser: { id: "eu_someone" } }),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports 410 when the replayed upload's reuse window has elapsed", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-gone" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_rerun_gone_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(scope, { id: priorRunId, input: { doc: `upload://${id}` } });
    // The upload was consumed long ago — past the 24h reuse window.
    await db
      .update(uploads)
      .set({ consumedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(uploads.id, id));

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("rejects replaying materialized inline data: inputs with 409 rerun_inline_input_unavailable", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-inline" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };

    // The prior run's persisted input holds the payload-stripped marker the
    // consume path writes in place of inline bytes (empty payload + `name`
    // param). Pre-fix, replaying it walked into parseDataUri and surfaced a
    // misleading 400 "data: URI payload is empty".
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(scope, {
      id: priorRunId,
      input: { doc: "data:application/pdf;name=report.pdf;base64," },
    });

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 409, code: "rerun_inline_input_unavailable" });
  });

  it("a fresh (non-rerun) empty inline payload still surfaces the plain 400", async () => {
    // Marker detection is rerun-only — a direct request carrying an
    // empty-payload data URI keeps today's invalid_request contract.
    const ctx = await createTestContext({ orgSlug: "org-rerun-fresh" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };

    await expect(
      parseRequestInput(
        fakeCtx({ input: { doc: "data:application/pdf;name=report.pdf;base64," } }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("replays a run with null input as no input (collapsed to undefined)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-null" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(scope, { id: priorRunId, input: null });

    const result = await parseRequestInput(
      fakeCtx({ rerun_from: priorRunId }, scope),
      `run_${crypto.randomUUID()}`,
      // No file fields required — empty input passes an empty schema.
      { type: "object", properties: {} },
    );
    // An effectively-empty replayed input collapses to `undefined` so it
    // persists as SQL NULL, matching a fresh input-less trigger.
    expect(result.input).toBeUndefined();
    expect(result.uploadedFiles).toBeUndefined();
  });
});

describe("parseRequestInput — colliding document names (workspace-name hardening)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  const arrayFileSchema: JSONSchemaObject = {
    type: "object",
    properties: {
      docs: {
        type: "array",
        items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
        maxItems: 5,
      },
    },
  };

  it("gives colliding upload/document/inline inputs unique workspace names, preserving display names", async () => {
    const ctx = await createTestContext({ orgSlug: "org-collide" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const actor = { type: "user" as const, id: ctx.user.id };

    // An upload named report.pdf.
    const uploadId = "upl_collide_1";
    await seedUpload(scope, { id: uploadId, bytes: PDF_BYTES, name: "report.pdf" });

    // A durable agent_output document ALSO named report.pdf.
    const producerRunId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: producerRunId,
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      status: "running",
    });
    const { row: doc } = await createDocumentFromStream(
      scope,
      producerRunId,
      { userId: ctx.user.id, endUserId: null },
      null,
      { name: "report.pdf", mime: "application/pdf", body: new Blob([PDF_BYTES]).stream() },
    );

    // An inline file ALSO named report.pdf.
    const inlineUri = `data:application/pdf;name=report.pdf;base64,${PDF_BYTES.toString("base64")}`;

    const runId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx(
        { input: { docs: [`upload://${uploadId}`, `document://${doc.id}`, inlineUri] } },
        { ...scope, user: { id: actor.id } },
      ),
      runId,
      arrayFileSchema,
    );

    // All three documents surfaced, all keeping their human display name.
    expect(result.uploadedFiles).toHaveLength(3);
    expect(result.uploadedFiles!.every((f) => f.name === "report.pdf")).toBe(true);

    // The manifest served to the container carries three UNIQUE workspace names,
    // display names preserved — no silent overwrite.
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toHaveLength(3);
    expect(manifest!.documents.map((d) => d.name)).toEqual([
      "report.pdf",
      "report.pdf",
      "report.pdf",
    ]);
    const workspaceNames = manifest!.documents.map((d) => d.workspace_name);
    expect(new Set(workspaceNames).size).toBe(3);
    expect(workspaceNames).toEqual(["report.pdf", "report-2.pdf", "report-3.pdf"]);

    // Each document is independently fetchable at its own workspace name.
    for (const name of workspaceNames) {
      const stream = await downloadRunDocumentStream(runId, name);
      expect(stream).not.toBeNull();
      expect(new Uint8Array(await new Response(stream!).arrayBuffer())).toEqual(
        new Uint8Array(PDF_BYTES),
      );
    }
  });
});

describe("isStrippedInlineMarker", () => {
  it("matches only the payload-stripped marker shape (empty payload + name param)", () => {
    expect(isStrippedInlineMarker("data:application/pdf;name=report.pdf;base64,")).toBe(true);
    expect(isStrippedInlineMarker("data:text/plain;name=a%20b.txt;base64,")).toBe(true);
    // Payload present → a real inline file, not the marker.
    expect(isStrippedInlineMarker("data:text/plain;name=a.txt;base64,aGk=")).toBe(false);
    // No name param → a (broken) plain empty data URI, not the marker.
    expect(isStrippedInlineMarker("data:text/plain;base64,")).toBe(false);
    // Not a data URI at all.
    expect(isStrippedInlineMarker("upload://upl_x")).toBe(false);
    expect(isStrippedInlineMarker("data:text/plain;name=a.txt;base64")).toBe(false);
  });
});
