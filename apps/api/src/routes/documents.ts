// SPDX-License-Identifier: Apache-2.0

/**
 * Documents API — gallery listing, metadata, content download, delete.
 *
 *   GET    /api/documents             → list (org+app scoped, actor-filtered)
 *   GET    /api/documents/:id         → metadata DTO (+ derived `downloadable`)
 *   GET    /api/documents/:id/content → 307 → presigned GET, or proxy-stream
 *   DELETE /api/documents/:id         → delete (documents:delete perm OR creator)
 *
 * Reads carry no `requirePermission` — access is inherited from the document's
 * container (run read-ACL, or chat-session owner) at check time, mirroring the
 * runs read model. The end-user guard is applied inside `getDocumentForActor`.
 */

import { Hono } from "hono";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { forbidden, notFound, payloadTooLarge, unauthorized } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { createDownloadUrl } from "@appstrate/db/storage";
import { zDocumentPurposeEnum } from "@appstrate/db/schema";
import {
  getDocumentForActor,
  listDocumentsForActor,
  deleteDocument,
  toDocumentDto,
  streamDocumentContent,
  loadDocumentForPreview,
  type ListDocumentsFilters,
} from "../services/documents.ts";
import {
  verifyPreviewToken,
  isHtmlMime,
  buildPreviewCsp,
  injectMetaCsp,
  PREVIEW_MAX_BYTES,
} from "../services/document-preview.ts";

/**
 * Build a safe `Content-Disposition: attachment` header for a filename.
 * Emits both an ASCII fallback (control chars incl. CR/LF, quotes, backslashes,
 * and non-ASCII collapsed to `_`, so no header injection or client parse break)
 * and an RFC 5987 `filename*` with the UTF-8 name percent-encoded, which
 * compliant clients prefer for the real (possibly non-ASCII) name.
 */
function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createDocumentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/documents — gallery list. Filters: purpose, run_id, package_id,
  // chat_session_id; keyset pagination via starting_after + limit.
  router.get("/documents", rateLimit(120), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);

    const filters: ListDocumentsFilters = {};
    const purpose = zDocumentPurposeEnum.safeParse(c.req.query("purpose"));
    if (purpose.success) filters.purpose = purpose.data;
    const runId = c.req.query("run_id");
    if (runId) filters.runId = runId;
    const packageId = c.req.query("package_id");
    if (packageId) filters.packageId = packageId;
    const chatSessionId = c.req.query("chat_session_id");
    if (chatSessionId) filters.chatSessionId = chatSessionId;
    const startingAfter = c.req.query("starting_after");
    if (startingAfter) filters.startingAfter = startingAfter;
    const limitRaw = Number(c.req.query("limit"));
    if (Number.isInteger(limitRaw) && limitRaw > 0) filters.limit = limitRaw;

    const page = await listDocumentsForActor(scope, actor, filters);
    return c.json(page);
  });

  // GET /api/documents/:id — metadata DTO.
  router.get("/documents/:id", async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(scope, actor, c.req.param("id")!);
    if (!resolved) throw notFound("Document not found");
    return c.json(toDocumentDto(resolved.row, actor));
  });

  // GET /api/documents/:id/content — download the bytes. Gated by the derived
  // `downloadable` flag (a user upload is served only to its creator). 307 to a
  // presigned GET when storage supports it (S3 with a public endpoint), else
  // proxy-stream. Content-Disposition: attachment.
  router.get("/documents/:id/content", rateLimit(120), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(scope, actor, c.req.param("id")!);
    if (!resolved) throw notFound("Document not found");
    if (!resolved.downloadable) {
      throw forbidden("This document is not downloadable by the current actor");
    }
    const { row } = resolved;

    const [bucket, ...rest] = row.storageKey.split("/");
    const presigned =
      bucket && rest.length > 0
        ? await createDownloadUrl(bucket, rest.join("/"), {
            filename: row.name,
            contentType: row.mime,
          })
        : null;
    if (presigned) return c.redirect(presigned, 307);

    const stream = await streamDocumentContent(row.storageKey);
    if (!stream) throw notFound("Document content not found");
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(row.size),
        "Content-Disposition": attachmentDisposition(row.name),
        "Cache-Control": "private, no-store",
      },
    });
  });

  // DELETE /api/documents/:id — allowed for a caller with the `documents:delete`
  // permission (owner/admin) OR the document's own creator.
  router.delete("/documents/:id", rateLimit(60), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(scope, actor, c.req.param("id")!);
    if (!resolved) throw notFound("Document not found");
    const { row } = resolved;

    const hasPermission = c.get("permissions")?.has("documents:delete") ?? false;
    const isCreator = actor.type === "user" ? row.userId === actor.id : row.endUserId === actor.id;
    if (!hasPermission && !isCreator) {
      throw forbidden("Only the document creator or an admin can delete this document");
    }

    await deleteDocument(scope, row.id);
    await recordAuditFromContext(c, {
      action: "document.deleted",
      resourceType: "document",
      resourceId: row.id,
      before: { name: row.name, size: row.size, mime: row.mime, purpose: row.purpose },
    });
    return c.body(null, 204);
  });

  return router;
}

/**
 * Cookie-less HTML preview router — MOUNTED OUTSIDE `/api`, BEFORE the auth
 * pipeline, so no cookie/API-key/org/app middleware ever touches it. Serves
 * untrusted agent-generated HTML in maximum isolation:
 *
 *  - Authorized ONLY by a short-lived signed token in the URL (`?t=`), never a
 *    cookie — verified constant-time, expiry-enforced, bound to this one
 *    document id. No session is read; a session WITHOUT a token is a 401.
 *  - A strict CSP header + an injected parse-time `<meta>` CSP (covers the
 *    relative-URL / `srcdoc` bypass a header alone can miss).
 *  - `nosniff`, `no-referrer`, a `Permissions-Policy` cutting camera/mic/geo/
 *    payment/usb, COOP `same-origin`, and a CORP tuned to whether the preview is
 *    served same-origin or on a separate `USERCONTENT_URL` domain. Never sets a
 *    cookie.
 *
 * Path `/preview/documents/:id` is a dedicated top-level namespace — it does NOT
 * share the `/documents` SPA page prefix, so it can never be shadowed by (nor
 * shadow) the client-side gallery route or the static SPA fallback.
 */
export function createDocumentPreviewRouter() {
  const router = new Hono<AppEnv>();

  // Cookie-less → no user/API-key identity to key on; rate-limit by client IP.
  router.get("/preview/documents/:id", rateLimitByIp(120), async (c) => {
    const env = getEnv();

    // Token IS the authorization — a missing/invalid/expired token is 401,
    // never a cookie fallback.
    const token = c.req.query("t");
    if (!token) throw unauthorized("Missing preview token");
    const payload = verifyPreviewToken(token, env.UPLOAD_SIGNING_SECRET);
    if (!payload) throw unauthorized("Invalid or expired preview token");
    // The token authorizes exactly ONE document — reject a token minted for a
    // different id replayed on this path.
    if (payload.d !== c.req.param("id"))
      throw unauthorized("Preview token does not match document");

    const row = await loadDocumentForPreview(payload.o, payload.d);
    // Only HTML is previewable this phase; anything else (or a missing/foreign
    // doc) is indistinguishable from not-found.
    if (!row || !isHtmlMime(row.mime)) throw notFound("Preview not available");
    if (row.size > PREVIEW_MAX_BYTES) {
      throw payloadTooLarge(`Preview exceeds the ${PREVIEW_MAX_BYTES}-byte limit`);
    }

    const stream = await streamDocumentContent(row.storageKey);
    if (!stream) throw notFound("Preview not available");

    // Buffer-and-transform: read the whole (capped) body, inject the meta CSP as
    // the first child of <head>, serve. Simple + correct over regex streaming.
    const html = await new Response(stream).text();
    const appOrigin = new URL(env.APP_URL).origin;
    const csp = buildPreviewCsp(appOrigin);
    const body = injectMetaCsp(html, csp);

    // When the preview is served from a SEPARATE origin (USERCONTENT_URL), the
    // app (APP_URL) embeds it cross-origin, so CORP must allow cross-origin
    // embedding; same-origin serving stays locked to same-origin.
    const corp = env.USERCONTENT_URL ? "cross-origin" : "same-origin";

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": corp,
      },
    });
  });

  return router;
}
