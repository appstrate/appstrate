// SPDX-License-Identifier: Apache-2.0

/**
 * Uploads API — direct-upload creation + filesystem sink.
 *
 *   POST /api/uploads            → create upload (auth + app context)
 *   PUT  /api/uploads/_content   → FS sink (public, HMAC token-authenticated)
 *
 * S3 and other cloud storages sign URLs pointing straight at the blob
 * store, so the PUT hits us only in filesystem mode.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { createUpload, writeFsUploadContent } from "../services/uploads.ts";
import { parseBody, invalidRequest, unauthorized } from "../lib/errors.ts";
import { verifyFsUploadToken } from "@appstrate/core/storage-fs";
import { getEnv } from "@appstrate/env";

const createUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  mime: z.string().min(1).max(255),
});

export function createUploadsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/uploads — create an upload descriptor (signed URL + DB row)
  router.post("/", rateLimit(120), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const data = parseBody(createUploadSchema, body);
    const upload = await createUpload({
      orgId,
      applicationId,
      createdBy: user?.id ?? null,
      name: data.name,
      size: data.size,
      mime: data.mime,
    });
    return c.json(upload, 201);
  });

  return router;
}

/**
 * Public router for the FS direct-upload sink.
 *
 *   PUT /api/uploads/_content?token=<signed>
 *
 * Token is HMAC-signed by the storage adapter and encodes:
 *  - storage key (bucket/path)
 *  - max allowed size
 *  - allowed mime (or empty = any)
 *  - expiry
 *
 * Rate limited aggressively — a valid token is single-use but the endpoint
 * is public so we want to cap brute-force attempts.
 */
export function createUploadContentRouter() {
  const router = new Hono<AppEnv>();

  router.put("/", rateLimitByIp(60), async (c) => {
    const token = c.req.query("token");
    if (!token) throw unauthorized("missing upload token");
    const env = getEnv();
    const payload = verifyFsUploadToken(token, env.UPLOAD_SIGNING_SECRET);
    if (!payload) throw unauthorized("invalid or expired upload token");

    // Normalize both sides: strip parameters (charset, boundary, …) and
    // lowercase. Prevents "application/pdf" vs "application/pdf; charset=…"
    // from mismatching, and catches attackers padding the signed MIME with
    // extra params.
    const normalize = (v: string) => v.split(";")[0]?.trim().toLowerCase() ?? "";
    const declaredType = c.req.header("content-type");
    const signedMime = normalize(payload.m);
    if (signedMime && declaredType && normalize(declaredType) !== signedMime) {
      throw invalidRequest(`Content-Type '${declaredType}' does not match signed '${payload.m}'`);
    }

    const lenHdr = c.req.header("content-length");
    if (lenHdr) {
      const len = Number(lenHdr);
      if (Number.isFinite(len) && payload.s > 0 && len > payload.s) {
        throw invalidRequest(`Content-Length ${len} exceeds signed max ${payload.s}`);
      }
    }

    const arrayBuf = await c.req.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    if (payload.s > 0 && bytes.byteLength > payload.s) {
      throw invalidRequest(`body (${bytes.byteLength} bytes) exceeds signed max ${payload.s}`);
    }

    await writeFsUploadContent(payload.k, bytes);
    return c.body(null, 204);
  });

  return router;
}
