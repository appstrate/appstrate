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
import { z } from "zod";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { getActor, actorFromIds } from "../lib/actor.ts";
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
  deriveDownloadable,
  parseStorageKey,
  type ListDocumentsFilters,
} from "../services/documents.ts";
import {
  verifyPreviewToken,
  previewKind,
  buildPreviewCsp,
  buildInertPreviewCsp,
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

  // GET /api/documents — gallery list. Filters: purpose, run_id, packageId,
  // chat_session_id; keyset pagination via startingAfter + limit. Query-param
  // casing follows the wire DTO (CASING_CONVENTIONS.md carve-out 4b): `packageId`
  // and the `startingAfter` pagination param are camelCase; `run_id` /
  // `chat_session_id` are snake_case domain fields.
  router.get("/documents", rateLimit(120), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);

    const filters: ListDocumentsFilters = {};
    const purpose = zDocumentPurposeEnum.safeParse(c.req.query("purpose"));
    if (purpose.success) filters.purpose = purpose.data;
    const runId = c.req.query("run_id");
    if (runId) filters.runId = runId;
    const packageId = c.req.query("packageId");
    if (packageId) filters.packageId = packageId;
    const chatSessionId = c.req.query("chat_session_id");
    if (chatSessionId) filters.chatSessionId = chatSessionId;
    const startingAfter = c.req.query("startingAfter");
    if (startingAfter) filters.startingAfter = startingAfter;
    // Documented query-int idiom (routes/models.ts): coerce + clamp + default.
    filters.limit = z.coerce.number().int().min(1).max(100).catch(20).parse(c.req.query("limit"));

    const page = await listDocumentsForActor(scope, actor, filters);
    return c.json(page);
  });

  // GET /api/documents/:id — metadata DTO. Token-minting route (the single GET
  // mints the signed `preview_url`), so it is rate-limited like the others.
  router.get("/documents/:id", rateLimit(120), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(scope, actor, c.req.param("id")!);
    if (!resolved) throw notFound("Document not found");
    return c.json(toDocumentDto(resolved.row, actor, resolved.downloadable, { mintPreview: true }));
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

    const parsed = parseStorageKey(row.storageKey);
    const presigned = parsed
      ? await createDownloadUrl(parsed.bucket, parsed.path, {
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
        // The MIME is agent/uploader-controlled — forbid content-type sniffing
        // so a mislabelled body can never be reinterpreted as active content
        // (S3). Attachment disposition already prevents inline rendering.
        "X-Content-Type-Options": "nosniff",
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
 * Cookie-less document preview router — MOUNTED OUTSIDE `/api`, BEFORE the auth
 * pipeline, so no cookie/API-key/org/app middleware ever touches it. Serves a
 * previewable document in maximum isolation, branching on its
 * {@link previewKind}:
 *
 *  - `html` — untrusted agent-generated ACTIVE content: a strict CSP header + an
 *    injected parse-time `<meta>` CSP (covers the relative-URL / `srcdoc` bypass
 *    a header alone can miss), COOP `same-origin`, the full `Permissions-Policy`.
 *  - `image` / `pdf` / `text` — INERT content streamed byte-for-byte with a
 *    minimal `default-src 'none'` CSP, `inline` disposition and `nosniff`; text
 *    is always relabelled `text/plain` so no markdown→HTML sniff is possible.
 *
 * Every kind is:
 *  - Authorized ONLY by a short-lived signed token in the URL (`?t=`), never a
 *    cookie — verified constant-time, expiry-enforced, bound to this one
 *    document id. No session is read; a session WITHOUT a token is a 401.
 *  - Served with `nosniff`, `no-referrer`, COOP `same-origin`, and a CORP tuned
 *    to whether the preview is served same-origin or on a separate
 *    `USERCONTENT_URL` domain. Never sets a cookie.
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
    // Classify the mime into a preview kind; a non-previewable mime (or a
    // missing/foreign doc) is indistinguishable from not-found.
    const kind = row ? previewKind(row.mime) : null;
    if (!row || !kind) throw notFound("Preview not available");

    // Defense-in-depth (S1) — applies to EVERY kind: a `user_upload` is
    // creator-only content, so its preview is refused unless the token's bound
    // minting actor is the document's creator — even a hand-crafted token that
    // verifies. An `agent_output` is previewable by anyone who resolved the
    // container (deriveDownloadable is always true for it), so this gate is a
    // no-op there.
    if (row.purpose === "user_upload") {
      const tokenActor = actorFromIds(payload.u ?? null, payload.eu ?? null);
      if (!tokenActor || !deriveDownloadable(row, tokenActor)) {
        throw unauthorized("Preview token does not authorize this document");
      }
    }
    if (row.size > PREVIEW_MAX_BYTES) {
      throw payloadTooLarge(`Preview exceeds the ${PREVIEW_MAX_BYTES}-byte limit`);
    }

    const stream = await streamDocumentContent(row.storageKey);
    if (!stream) throw notFound("Preview not available");

    const appOrigin = new URL(env.APP_URL).origin;
    // When the preview is served from a SEPARATE origin (USERCONTENT_URL), the
    // app (APP_URL) embeds it cross-origin, so CORP must allow cross-origin
    // embedding; same-origin serving stays locked to same-origin.
    const corp = env.USERCONTENT_URL ? "cross-origin" : "same-origin";

    if (kind === "html") {
      // Active content — the full hardened treatment, UNCHANGED. Buffer-and-
      // transform: read the whole (capped) body, inject the meta CSP as the
      // first child of <head>, serve. Simple + correct over regex streaming.
      const html = await new Response(stream).text();
      const csp = buildPreviewCsp(appOrigin);
      const body = injectMetaCsp(html, csp);
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
    }

    // Inert kinds — image | pdf | text. These stream byte-for-byte (no buffer,
    // no transform), with a minimal `default-src 'none'` CSP as belt-and-braces
    // (they cannot execute in the embedding origin) and `inline` disposition so
    // the browser renders rather than downloads.
    //
    // Content-Type is fixed PER KIND, never blindly echoed:
    //  - text kinds are ALWAYS relabelled `text/plain; charset=utf-8` (never the
    //    stored `text/markdown` etc.), eliminating any text→HTML sniff surface.
    //  - image/pdf carry their stored mime.
    // The stored mime is agent-declared, but `nosniff` makes the browser TRUST
    // the declared type — so a body mislabelled `application/pdf` that is really
    // HTML renders as a broken PDF in the native viewer, NEVER as active HTML in
    // the app origin. That, plus the fixed per-kind Content-Type, closes the
    // mime-smuggling path even though the label is not under our control.
    // The text kind is rendered client-side (the SPA `fetch()`es this URL and
    // shows the bytes in a `<pre>`); when the preview lives on a separate
    // USERCONTENT_URL origin that read is cross-origin. The global CORS
    // middleware (mounted `*` ahead of this router, keyed on the trusted origins
    // — which always include APP_URL where the SPA lives) already emits the
    // `Access-Control-Allow-Origin` for it, so no per-route CORS header is
    // needed here. image/pdf are embedded (`<img>` / native-PDF `<iframe>`), not
    // fetched, so CORS is irrelevant to them.
    const contentType = kind === "text" ? "text/plain; charset=utf-8" : row.mime;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(row.size),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": buildInertPreviewCsp(appOrigin),
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": corp,
      },
    });
  });

  return router;
}
