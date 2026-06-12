// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the FS direct-upload sink:
 *
 *   PUT /api/uploads/_content?token=<HMAC-signed>
 *
 * Covers token authentication, MIME pinning, replay protection (O_EXCL), and
 * the signed-max-size enforcement DURING streaming — a chunked body with no
 * Content-Length header must be aborted as soon as the byte count crosses the
 * token's signed max, with no partial object left behind (the still-valid
 * token stays usable for a clean retry).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { signFsUploadToken, type FsUploadTokenPayload } from "@appstrate/core/storage-fs";
import { downloadFile as storageGet, fileExists as storageExists } from "@appstrate/db/storage";

const app = getTestApp();
const SECRET = process.env.UPLOAD_SIGNING_SECRET!;
const BUCKET = "uploads";

/** Unique storage path per test — truncateAll() resets the DB, not storage. */
function uniquePath(label: string): string {
  return `app_test/upl_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}/file.bin`;
}

function makeToken(overrides: Partial<FsUploadTokenPayload> & { k: string }): string {
  return signFsUploadToken(
    {
      s: 0,
      m: "",
      e: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    },
    SECRET,
  );
}

function putContent(
  token: string | null,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  headers?: Record<string, string>,
) {
  const qs = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  return app.request(`/api/uploads/_content${qs}`, {
    method: "PUT",
    ...(body !== null ? { body } : {}),
    ...(headers ? { headers } : {}),
    // Required by the fetch spec when the body is a ReadableStream.
    ...({ duplex: "half" } as RequestInit),
  });
}

describe("PUT /api/uploads/_content", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a missing token with 401", async () => {
    const res = await putContent(null, new Uint8Array([1]));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered token with 401", async () => {
    const token = makeToken({ k: `${BUCKET}/${uniquePath("tampered")}` });
    const res = await putContent(token.slice(0, -2) + "xx", new Uint8Array([1]));
    expect(res.status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const token = makeToken({
      k: `${BUCKET}/${uniquePath("expired")}`,
      e: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await putContent(token, new Uint8Array([1]));
    expect(res.status).toBe(401);
  });

  it("rejects a Content-Type that does not match the signed MIME", async () => {
    const token = makeToken({
      k: `${BUCKET}/${uniquePath("mime")}`,
      m: "application/pdf",
    });
    const res = await putContent(token, new Uint8Array([1, 2, 3]), {
      "Content-Type": "text/plain",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid PUT (204), stores the bytes, and 409s a replay", async () => {
    const path = uniquePath("happy");
    const token = makeToken({ k: `${BUCKET}/${path}`, s: 1024 });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    const res = await putContent(token, bytes);
    expect(res.status).toBe(204);
    expect(await storageGet(BUCKET, path)).toEqual(bytes);

    // Replaying the same (still-valid) token must not swap the bytes.
    const replay = await putContent(token, new Uint8Array([9, 9, 9, 9]));
    expect(replay.status).toBe(409);
    expect(await storageGet(BUCKET, path)).toEqual(bytes);
  });

  it("aborts a chunked body (no Content-Length) that exceeds the signed max", async () => {
    const path = uniquePath("chunked");
    const token = makeToken({ k: `${BUCKET}/${path}`, s: 4 * 1024 });

    // Stream 8 KiB in 1 KiB chunks — a chunked-transfer request carries no
    // Content-Length, so the old header pre-check alone could not stop it.
    const chunk = new Uint8Array(1024).fill(7);
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await putContent(token, oversized);
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { detail?: string };
    expect(problem.detail).toContain("exceeds signed max");

    // No partial object retained — the token stays usable for a clean retry.
    expect(await storageExists(BUCKET, path)).toBe(false);
    const retry = await putContent(token, new Uint8Array([1, 2, 3]));
    expect(retry.status).toBe(204);
    expect(await storageGet(BUCKET, path)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const path = uniquePath("clpre");
    const token = makeToken({ k: `${BUCKET}/${path}`, s: 16 });
    const res = await putContent(token, new Uint8Array(8), { "Content-Length": "1048576" });
    // The header pre-check fails fast on an honest oversized declaration —
    // before any body byte is read (the streaming counter remains the binding
    // check for dishonest/chunked requests).
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { detail?: string };
    expect(problem.detail).toContain("exceeds signed max");
    expect(await storageExists(BUCKET, path)).toBe(false);
  });
});
