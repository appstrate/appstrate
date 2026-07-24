// SPDX-License-Identifier: Apache-2.0

/**
 * Uploads API — direct-upload creation + proxy-upload sink.
 *
 *   POST /api/uploads            → create upload (auth + app context)
 *   PUT  /api/uploads/_content   → proxy sink (public, HMAC token-authenticated)
 *
 * The sink serves BOTH storage backends: filesystem always PUTs here, and
 * the S3 backend does too in proxy mode (`S3_PUBLIC_ENDPOINT` unset — the
 * platform streams the body to the private bucket server-side, issue #829).
 * Only direct-presign S3 mode (`S3_PUBLIC_ENDPOINT` set) sends the PUT
 * straight at the blob store, bypassing this route.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { createUpload, writeProxyUploadContent } from "../services/uploads.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { invalidRequest, unauthorized } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { getActor, actorInsert } from "../lib/actor.ts";
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
  // Optional client integrity claim: lowercase-hex SHA-256, verified
  // server-side (S3 checksum on PUT, proxy-sink re-hash, and again at consume).
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "sha256 must be a 64-character hex SHA-256 digest")
    .optional(),
});

export function createUploadsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/uploads — create an upload descriptor (signed URL + DB row)
  // 20/min/user — aligned with POST /agents/:id/run. Each descriptor reserves
  // up to 100 MB of signed PUT capacity, so a higher ceiling would let a single
  // session book multi-GB of storage slots per minute before GC catches up.
  router.post("/", rateLimit(20), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // Record BOTH creator identities (dashboard/API-key user OR end-user) so the
    // ownership gate on peek/consume can enforce that only the uploading
    // principal reads its own staged bytes. `actorInsert` produces the exact
    // {userId, endUserId} pair for whichever principal is in context.
    const { userId, endUserId } = actorInsert(getActor(c));
    const data = await readJsonBody(c, createUploadSchema, { allowEmpty: true });
    const upload = await createUpload({
      orgId,
      applicationId,
      createdBy: userId,
      endUserId,
      name: data.name,
      size: data.size,
      mime: data.mime,
      ...(data.sha256 ? { sha256: data.sha256 } : {}),
    });
    await recordAuditFromContext(c, {
      action: "upload.created",
      resourceType: "upload",
      resourceId: upload.id,
      after: { name: data.name, size: data.size, mime: data.mime },
    });
    return c.json(upload, 201);
  });

  return router;
}

/**
 * Public router for the proxy-upload sink (filesystem storage, and S3
 * storage in proxy mode).
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

  // Middleware order — the IP-keyed limiter INTENTIONALLY runs BEFORE the token
  // check. This endpoint is PUBLIC (the HMAC token is the only credential and it
  // arrives in the body/query), so there is no authenticated identity to key on;
  // rate-limiting by client IP first is exactly what caps brute-force token
  // guessing before any verification work. (Contrast the run-document route,
  // whose limiter keys on a URL runId and so must verify FIRST.)
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

    // Fast-fail on an honest oversized Content-Length. Advisory only — a
    // chunked request carries no length up front, so the binding check is the
    // counting transform inside writeProxyUploadContent, which aborts the
    // streaming write (and removes the partial file) past the signed max.
    const lenHdr = c.req.header("content-length");
    if (lenHdr) {
      const len = Number(lenHdr);
      if (Number.isFinite(len) && payload.s > 0 && len > payload.s) {
        throw invalidRequest(`Content-Length ${len} exceeds signed max ${payload.s}`);
      }
    }

    // Stream the body straight to the storage backend (disk, or S3 via
    // multipart upload) — never buffered in memory (this route is exempt from
    // the global bodyLimit; the token's signed max replaces it). The token
    // expiry is passed through so it keeps being enforced WHILE the body
    // streams — verified only up front, a slow-trickled body could hold the
    // socket (and an open S3 multipart upload) long past the token window.
    const body = c.req.raw.body ?? new Blob([]).stream();
    // `payload.h` is the token's signed sha256 (when the client declared one);
    // the sink re-hashes the streamed bytes and rejects a mismatch (400).
    await writeProxyUploadContent(payload.k, body, payload.s, payload.e, payload.h);
    return c.body(null, 204);
  });

  return router;
}
