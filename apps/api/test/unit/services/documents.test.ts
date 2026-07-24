// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure helpers in the documents service: the single access-
 * capability computation (D2 / Anthropic rule + the `user_upload` privacy
 * decision), the org-quota math, retention-expiry stamping, the `document://`
 * URI parser, and the streaming SHA-256 counter.
 */

import { describe, it, expect } from "bun:test";
import {
  getDocumentCapabilities,
  wouldExceedOrgQuota,
  effectiveOrgStorageLimit,
  retentionExpiry,
  createHashingCounter,
  toDocumentDto,
  type DocumentRow,
} from "../../../src/services/documents.ts";
import { isDocumentUri, parseDocumentUri, documentUri } from "@appstrate/core/document-uri";
import type { Actor } from "@appstrate/connect";

const userA: Actor = { type: "user", id: "user-a" };
const userB: Actor = { type: "user", id: "user-b" };
const euA: Actor = { type: "end_user", id: "eu-a" };
const euB: Actor = { type: "end_user", id: "eu-b" };

describe("getDocumentCapabilities", () => {
  const mime = "text/plain"; // not previewable → preview stays false throughout

  it("a non-visible document collapses every capability to false", () => {
    const doc = { purpose: "agent_output" as const, userId: null, endUserId: null, mime };
    expect(getDocumentCapabilities(doc, userA, { visible: false })).toEqual({
      visible: false,
      metadata: false,
      download: false,
      preview: false,
      keep: false,
      delete: false,
    });
  });

  it("an agent output grants metadata + download to anyone who can read the container", () => {
    const doc = { purpose: "agent_output" as const, userId: "user-a", endUserId: null, mime };
    for (const actor of [userA, userB, euA]) {
      const caps = getDocumentCapabilities(doc, actor, { visible: true });
      expect(caps.metadata).toBe(true);
      expect(caps.download).toBe(true);
    }
  });

  it("a user upload reserves metadata + download to its creator (user)", () => {
    const doc = { purpose: "user_upload" as const, userId: "user-a", endUserId: null, mime };
    const creator = getDocumentCapabilities(doc, userA, { visible: true });
    expect(creator.metadata).toBe(true);
    expect(creator.download).toBe(true);
    for (const other of [userB, euA]) {
      const caps = getDocumentCapabilities(doc, other, { visible: true });
      // Visible (resolved the container) but opaque: no metadata, no bytes.
      expect(caps.metadata).toBe(false);
      expect(caps.download).toBe(false);
    }
  });

  it("a user upload reserves metadata + download to its creator (end-user)", () => {
    const doc = { purpose: "user_upload" as const, userId: null, endUserId: "eu-a", mime };
    expect(getDocumentCapabilities(doc, euA, { visible: true }).download).toBe(true);
    expect(getDocumentCapabilities(doc, euB, { visible: true }).download).toBe(false);
    expect(getDocumentCapabilities(doc, userA, { visible: true }).download).toBe(false);
  });

  it("keep/delete follow creator OR the documents:delete grant (canManage)", () => {
    const doc = { purpose: "user_upload" as const, userId: "user-a", endUserId: null, mime };
    // Creator, no manage grant → keep/delete via creator.
    const creator = getDocumentCapabilities(doc, userA, { visible: true });
    expect(creator.keep).toBe(true);
    expect(creator.delete).toBe(true);
    // Non-creator without the grant → no lifecycle control.
    const stranger = getDocumentCapabilities(doc, userB, { visible: true });
    expect(stranger.keep).toBe(false);
    expect(stranger.delete).toBe(false);
    // Non-creator WITH the grant → may keep/delete, but the manage permission
    // never widens metadata/download of another member's upload.
    const admin = getDocumentCapabilities(doc, userB, { visible: true, canManage: true });
    expect(admin.keep).toBe(true);
    expect(admin.delete).toBe(true);
    expect(admin.metadata).toBe(false);
    expect(admin.download).toBe(false);
  });

  it("preview requires download AND a previewable mime", () => {
    const html = {
      purpose: "agent_output" as const,
      userId: null,
      endUserId: null,
      mime: "text/html",
    };
    expect(getDocumentCapabilities(html, userA, { visible: true }).preview).toBe(true);
    // A non-previewable mime (e.g. a zip) → no preview even when downloadable.
    const zip = {
      purpose: "agent_output" as const,
      userId: null,
      endUserId: null,
      mime: "application/zip",
    };
    expect(getDocumentCapabilities(zip, userA, { visible: true }).preview).toBe(false);
    const priv = {
      purpose: "user_upload" as const,
      userId: "user-a",
      endUserId: null,
      mime: "text/html",
    };
    // Non-creator can't download → can't preview even a previewable mime.
    expect(getDocumentCapabilities(priv, userB, { visible: true }).preview).toBe(false);
  });
});

describe("toDocumentDto — capabilities + metadata degradation", () => {
  const uploadRow = (over: Partial<DocumentRow> = {}): DocumentRow => ({
    id: "doc_degrade12345",
    orgId: "org-1",
    applicationId: "app-1",
    purpose: "user_upload",
    runId: "run-1",
    chatSessionId: null,
    packageId: null,
    userId: "user-a",
    endUserId: null,
    storageKey: "documents/app-1/doc_degrade12345/secret.pdf",
    name: "secret.pdf",
    mime: "application/pdf",
    size: 42,
    sha256: "a".repeat(64),
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  });

  it("a non-creator reader gets an opaque DTO: generic name, generic mime, no sha256", () => {
    const row = uploadRow();
    const caps = getDocumentCapabilities(row, userB, { visible: true });
    const dto = toDocumentDto(row, userB, caps);
    expect(dto.name).toBe("document");
    expect(dto.mime).toBe("application/octet-stream");
    expect(dto.sha256).toBeUndefined();
    expect(dto.downloadable).toBe(false);
    expect(dto.capabilities).toMatchObject({ visible: true, metadata: false, download: false });
    // Non-sensitive fields still ride through.
    expect(dto.id).toBe(row.id);
    expect(dto.size).toBe(42);
    expect(dto.purpose).toBe("user_upload");
  });

  it("the creator gets the real name, mime and sha256", () => {
    const row = uploadRow();
    const caps = getDocumentCapabilities(row, userA, { visible: true });
    const dto = toDocumentDto(row, userA, caps);
    expect(dto.name).toBe("secret.pdf");
    expect(dto.mime).toBe("application/pdf");
    expect(dto.sha256).toBe("a".repeat(64));
    expect(dto.capabilities.metadata).toBe(true);
  });
});

describe("toDocumentDto — preview_url honours the downloadable gate (S1)", () => {
  const htmlRow = (over: Partial<DocumentRow> = {}): DocumentRow => ({
    id: "doc_previewgate12",
    orgId: "org-1",
    applicationId: "app-1",
    purpose: "user_upload",
    runId: "run-1",
    chatSessionId: null,
    packageId: null,
    userId: "user-a",
    endUserId: null,
    storageKey: "documents/app-1/doc_previewgate12/page.html",
    name: "page.html",
    mime: "text/html",
    size: 10,
    sha256: "0".repeat(64),
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  });

  // Single-document GET semantics: pass `mintPreview` so `preview_url` is minted
  // (list rows carry only the `previewable` boolean).
  const singleDto = (row: DocumentRow, actor: Actor) =>
    toDocumentDto(row, actor, getDocumentCapabilities(row, actor, { visible: true }), {
      mintPreview: true,
    });

  it("a non-creator member gets NO preview_url for an html user_upload (cross-member disclosure blocked)", () => {
    const dto = singleDto(htmlRow(), userB);
    expect(dto.downloadable).toBe(false);
    expect(dto.previewable).toBe(false);
    expect(dto.preview_url).toBeNull();
  });

  it("the creator gets a working preview_url for their own html user_upload", () => {
    const dto = singleDto(htmlRow(), userA);
    expect(dto.downloadable).toBe(true);
    expect(dto.previewable).toBe(true);
    expect(dto.preview_url).toContain("/preview/documents/doc_previewgate12?t=");
  });

  it("an html agent_output stays previewable by anyone who resolved the container", () => {
    const dto = singleDto(htmlRow({ purpose: "agent_output" }), userB);
    expect(dto.downloadable).toBe(true);
    expect(dto.previewable).toBe(true);
    expect(dto.preview_url).toContain("/preview/documents/doc_previewgate12?t=");
  });

  it("list rows carry `previewable` but never mint a `preview_url`", () => {
    const row = htmlRow({ purpose: "agent_output" });
    const dto = toDocumentDto(row, userB, getDocumentCapabilities(row, userB, { visible: true }));
    expect(dto.previewable).toBe(true);
    expect(dto.preview_url).toBeUndefined();
  });
});

describe("wouldExceedOrgQuota", () => {
  it("no quota configured ⇒ never exceeds", () => {
    expect(wouldExceedOrgQuota(1_000_000, 1_000_000, undefined)).toBe(false);
  });

  it("a write landing exactly on the quota succeeds; one byte over fails", () => {
    expect(wouldExceedOrgQuota(90, 10, 100)).toBe(false);
    expect(wouldExceedOrgQuota(91, 10, 100)).toBe(true);
    expect(wouldExceedOrgQuota(0, 100, 100)).toBe(false);
    expect(wouldExceedOrgQuota(0, 101, 100)).toBe(true);
  });
});

describe("effectiveOrgStorageLimit", () => {
  it("no override + no env quota ⇒ undefined (unlimited)", () => {
    expect(effectiveOrgStorageLimit(null, undefined)).toBeUndefined();
    expect(effectiveOrgStorageLimit(undefined, undefined)).toBeUndefined();
  });

  it("no override + env quota ⇒ env quota", () => {
    expect(effectiveOrgStorageLimit(null, 1000)).toBe(1000);
    expect(effectiveOrgStorageLimit(undefined, 1000)).toBe(1000);
  });

  it("override present ⇒ override wins, regardless of env quota", () => {
    expect(effectiveOrgStorageLimit(500, undefined)).toBe(500);
    expect(effectiveOrgStorageLimit(500, 1000)).toBe(500); // below env quota
    expect(effectiveOrgStorageLimit(2000, 1000)).toBe(2000); // above env quota
  });

  it("a hard-zero override is honored (not treated as unset)", () => {
    expect(effectiveOrgStorageLimit(0, 1000)).toBe(0);
  });
});

describe("retentionExpiry", () => {
  it("undefined retention ⇒ permanent (null)", () => {
    expect(retentionExpiry(undefined)).toBeNull();
  });

  it("stamps now + N days", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const exp = retentionExpiry(7, now);
    expect(exp).not.toBeNull();
    expect(exp!.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("document URI helpers", () => {
  it("round-trips a valid document id", () => {
    const uri = documentUri("doc_abc12345");
    expect(uri).toBe("document://doc_abc12345");
    expect(isDocumentUri(uri)).toBe(true);
    expect(parseDocumentUri(uri)).toBe("doc_abc12345");
  });

  it("rejects malformed / foreign URIs", () => {
    expect(isDocumentUri("upload://upl_x")).toBe(false);
    expect(parseDocumentUri("document://nope")).toBeNull();
    expect(parseDocumentUri("document://doc_short")).toBeNull(); // < 8 id chars
    expect(parseDocumentUri("upload://upl_abc12345")).toBeNull();
  });
});

describe("createHashingCounter (streaming SHA-256)", () => {
  it("counts bytes and hashes them, matching a one-shot digest", async () => {
    const chunks = [
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("streaming "),
      new TextEncoder().encode("world"),
    ];
    const full = new TextEncoder().encode("hello streaming world");
    const expected = new Bun.CryptoHasher("sha256").update(full).digest("hex");

    const counter = createHashingCounter();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    // Drain the pass-through fully before reading the result.
    const drained = source.pipeThrough(counter.stream);
    const out = await new Response(drained).arrayBuffer();

    const { bytes, sha256 } = counter.result();
    expect(bytes).toBe(full.byteLength);
    expect(sha256).toBe(expected);
    expect(new Uint8Array(out)).toEqual(full);
  });

  it("result() is memoized (safe to call more than once)", async () => {
    const counter = createHashingCounter();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    });
    await new Response(source.pipeThrough(counter.stream)).arrayBuffer();
    expect(counter.result().sha256).toBe(counter.result().sha256);
    expect(counter.result().bytes).toBe(1);
  });
});
