// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure helpers in the documents service: the `downloadable`
 * derivation (D2 / Anthropic rule), the org-quota math, retention-expiry
 * stamping, the `document://` URI parser, and the streaming SHA-256 counter.
 */

import { describe, it, expect } from "bun:test";
import {
  deriveDownloadable,
  wouldExceedOrgQuota,
  retentionExpiry,
  isDocumentUri,
  parseDocumentUri,
  documentUri,
  createHashingCounter,
  toDocumentDto,
  type DocumentRow,
} from "../../../src/services/documents.ts";
import type { Actor } from "@appstrate/connect";

const userA: Actor = { type: "user", id: "user-a" };
const userB: Actor = { type: "user", id: "user-b" };
const euA: Actor = { type: "end_user", id: "eu-a" };
const euB: Actor = { type: "end_user", id: "eu-b" };

describe("deriveDownloadable", () => {
  it("an agent output is downloadable by anyone who can read the container", () => {
    const doc = { purpose: "agent_output" as const, userId: "user-a", endUserId: null };
    expect(deriveDownloadable(doc, userA)).toBe(true);
    expect(deriveDownloadable(doc, userB)).toBe(true);
    expect(deriveDownloadable(doc, euA)).toBe(true);
  });

  it("a user upload is downloadable only by its creator (user)", () => {
    const doc = { purpose: "user_upload" as const, userId: "user-a", endUserId: null };
    expect(deriveDownloadable(doc, userA)).toBe(true);
    expect(deriveDownloadable(doc, userB)).toBe(false);
    expect(deriveDownloadable(doc, euA)).toBe(false);
  });

  it("a user upload is downloadable only by its creator (end-user)", () => {
    const doc = { purpose: "user_upload" as const, userId: null, endUserId: "eu-a" };
    expect(deriveDownloadable(doc, euA)).toBe(true);
    expect(deriveDownloadable(doc, euB)).toBe(false);
    expect(deriveDownloadable(doc, userA)).toBe(false);
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

  it("a non-creator member gets NO preview_url for an html user_upload (cross-member disclosure blocked)", () => {
    const dto = toDocumentDto(htmlRow(), userB);
    expect(dto.downloadable).toBe(false);
    expect(dto.preview_url).toBeNull();
  });

  it("the creator gets a working preview_url for their own html user_upload", () => {
    const dto = toDocumentDto(htmlRow(), userA);
    expect(dto.downloadable).toBe(true);
    expect(dto.preview_url).toContain("/preview/documents/doc_previewgate12?t=");
  });

  it("an html agent_output stays previewable by anyone who resolved the container", () => {
    const dto = toDocumentDto(htmlRow({ purpose: "agent_output" }), userB);
    expect(dto.downloadable).toBe(true);
    expect(dto.preview_url).toContain("/preview/documents/doc_previewgate12?t=");
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
