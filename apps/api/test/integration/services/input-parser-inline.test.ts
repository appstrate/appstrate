// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `parseRequestInput`'s inline `data:` URI path — the
 * single-call alternative to the createUpload + signed PUT + runAgent dance
 * for JSON-only clients (MCP `invoke_operation`). Inline files are decoded
 * in-request, MIME-checked with the same magic-byte policy as staged uploads,
 * written to the run workspace, and payload-stripped from the persisted input.
 *
 * Real Postgres + FS storage, same harness as input-parser-stream.test.ts.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Context } from "hono";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import { parseRequestInput } from "../../../src/services/input-parser.ts";
import {
  downloadRunDocumentStream,
  downloadRunDocumentsManifest,
} from "../../../src/services/run-workspace-storage.ts";
import { uploadFile as storagePut } from "@appstrate/db/storage";
import { ApiError } from "../../../src/lib/errors.ts";
import type { JSONSchemaObject } from "@appstrate/core/form";

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n
const TEXT_BYTES = Buffer.from("hello world", "utf-8");

const singleTextSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    doc: { type: "string", format: "uri", contentMediaType: "text/plain" },
  },
};

const singlePdfSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
  },
};

const arrayFileSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    docs: {
      type: "array",
      items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
    },
  },
};

/** Minimal Hono context stub — parseRequestInput only reads the JSON body and orgId/applicationId. */
function fakeCtx(body: unknown, ctx: { orgId: string; applicationId: string }): Context {
  return {
    req: { json: async () => body },
    get: (key: string) =>
      key === "orgId" ? ctx.orgId : key === "applicationId" ? ctx.applicationId : undefined,
  } as unknown as Context;
}

async function readDoc(runId: string, name: string): Promise<Uint8Array | null> {
  const stream = await downloadRunDocumentStream(runId, name);
  if (!stream) return null;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("parseRequestInput — inline data: URIs", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("materializes an unnamed inline text file + strips the payload from the input", async () => {
    const ctx = await createTestContext({ orgSlug: "org-inline-text" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const runId = `run_${crypto.randomUUID()}`;

    const uri = `data:text/plain;base64,${TEXT_BYTES.toString("base64")}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: uri } }, scope),
      runId,
      singleTextSchema,
    );

    // Unnamed text/plain → named after the field with a .txt extension.
    expect(result.uploadedFiles).toEqual([
      { fieldName: "doc", name: "doc.txt", type: "text/plain", size: TEXT_BYTES.length },
    ]);

    // Bytes landed in the run workspace + manifest enumerates the document.
    expect(await readDoc(runId, "doc.txt")).toEqual(new Uint8Array(TEXT_BYTES));
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toEqual([{ name: "doc.txt", size: TEXT_BYTES.length }]);

    // The persisted input keeps a payload-stripped marker, not the base64 blob.
    expect(result.input?.doc).toBe("data:text/plain;name=doc.txt;base64,");
  });

  it("honours the data URI's name parameter", async () => {
    const ctx = await createTestContext({ orgSlug: "org-inline-named" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const runId = `run_${crypto.randomUUID()}`;

    const uri = `data:application/pdf;name=invoice.pdf;base64,${PDF_BYTES.toString("base64")}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: uri } }, scope),
      runId,
      singlePdfSchema,
    );

    expect(result.uploadedFiles).toEqual([
      { fieldName: "doc", name: "invoice.pdf", type: "application/pdf", size: PDF_BYTES.length },
    ]);
    expect(await readDoc(runId, "invoice.pdf")).toEqual(new Uint8Array(PDF_BYTES));
    expect(result.input?.doc).toBe("data:application/pdf;name=invoice.pdf;base64,");
  });

  it("rejects an inline file whose bytes do not match the declared binary MIME", async () => {
    const ctx = await createTestContext({ orgSlug: "org-inline-mime" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const runId = `run_${crypto.randomUUID()}`;

    // Declared application/pdf, payload is plain text → magic-byte sniff fails,
    // same policy as the staged-upload consume path.
    const uri = `data:application/pdf;base64,${TEXT_BYTES.toString("base64")}`;
    let thrown: unknown;
    try {
      await parseRequestInput(fakeCtx({ input: { doc: uri } }, scope), runId, singlePdfSchema);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect((thrown as ApiError).message).toContain("doc");

    // Nothing materialized.
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
  });

  it("mixes staged uploads and inline files in one array field", async () => {
    const ctx = await createTestContext({ orgSlug: "org-inline-mixed" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const runId = `run_${crypto.randomUUID()}`;

    // Stage one classic upload.
    const uploadId = "upl_inline_mix_1";
    const storagePath = `${ctx.defaultAppId}/${uploadId}/file.pdf`;
    await storagePut("uploads", storagePath, PDF_BYTES);
    await db.insert(uploads).values({
      id: uploadId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: null,
      storageKey: `uploads/${storagePath}`,
      name: "file.pdf",
      mime: "application/pdf",
      size: PDF_BYTES.length,
      expiresAt: new Date(Date.now() + 900 * 1000),
    });

    const inlineUri = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { docs: [`upload://${uploadId}`, inlineUri] } }, scope),
      runId,
      arrayFileSchema,
    );

    expect(result.uploadedFiles).toEqual([
      { fieldName: "docs", name: "file.pdf", type: "application/pdf", size: PDF_BYTES.length },
      // Unnamed inline array entry → field name + index suffix + sniffed extension.
      { fieldName: "docs", name: "docs-1.pdf", type: "application/pdf", size: PDF_BYTES.length },
    ]);

    // Both documents in the workspace + manifest.
    expect(await readDoc(runId, "file.pdf")).toEqual(new Uint8Array(PDF_BYTES));
    expect(await readDoc(runId, "docs-1.pdf")).toEqual(new Uint8Array(PDF_BYTES));
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toEqual([
      { name: "file.pdf", size: PDF_BYTES.length },
      { name: "docs-1.pdf", size: PDF_BYTES.length },
    ]);

    // Both entries are rewritten in the persisted input: the upload:// reference
    // becomes a durable document:// id (materialization deferred to the run
    // pipeline — one pending entry), the inline entry becomes its stripped marker.
    const docs = result.input?.docs as string[];
    expect(docs[0]).toStartWith("document://doc_");
    expect(docs[1]).toBe("data:application/pdf;name=docs-1.pdf;base64,");
    expect(result.pendingDocuments).toHaveLength(1);
    expect(result.pendingDocuments![0]).toMatchObject({ uploadId });
  });
});
