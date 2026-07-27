// SPDX-License-Identifier: Apache-2.0

/**
 * Documents API — gallery listing, metadata, content download, delete.
 *
 *   GET    /api/documents             → list (documents:read, actor-filtered)
 *   GET    /api/documents/:id         → metadata DTO (+ derived `downloadable`)
 *   GET    /api/documents/:id/content → 307 → presigned GET, or proxy-stream
 *   DELETE /api/documents/:id         → delete (documents:delete perm OR creator)
 *
 * Authorization is TWO layers, and both are load-bearing:
 *
 *   1. `documents:read` (this file) — "may this principal touch the documents
 *      family at all". Exactly what `runs:read` does for runs. Without it a
 *      key minted with the narrowest possible scope set (even `scopes: []`,
 *      which `validateScopes` accepts) could list and download every
 *      `agent_output` of the application.
 *   2. The per-document container ACL (`getDocumentForActor` /
 *      `getDocumentCapabilities`) — "may this ACTOR touch THIS document",
 *      inherited from the run read-ACL or the chat-session owner. The
 *      end-user guard lives there.
 *
 * DELETE/keep deliberately stay ungated at layer 1: they are authorized by
 * `capabilities.delete` / `capabilities.keep`, which grant the document's own
 * creator (an end-user cleaning up its own upload holds no org permission).
 */

import { Hono } from "hono";
import { z } from "zod";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor, actorFromIds } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { forbidden, notFound, payloadTooLarge, unauthorized } from "../lib/errors.ts";
import { reprDigestSha256 } from "../lib/digest.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { createDownloadUrl } from "@appstrate/db/storage";
import { attachmentDisposition } from "@appstrate/core/naming";
import { zDocumentPurposeEnum } from "@appstrate/db/schema";
import {
  getDocumentForActor,
  listDocumentsForActor,
  deleteDocument,
  clearDocumentExpiry,
  toDocumentDto,
  streamDocumentContent,
  loadDocumentForPreview,
  getDocumentCapabilities,
  parseStorageKey,
  type ListDocumentsFilters,
} from "../services/documents.ts";
import {
  verifyPreviewToken,
  previewKind,
  buildPreviewCsp,
  buildInertPreviewCsp,
  injectMetaCsp,
  mayServeActiveHtml,
  PREVIEW_MAX_BYTES,
} from "../services/document-preview.ts";

export function createDocumentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/documents — gallery list. Filters: purpose, run_id, packageId,
  // chat_session_id; keyset pagination via startingAfter + limit. Query-param
  // casing follows the wire DTO (CASING_CONVENTIONS.md carve-out 4b): `packageId`
  // and the `startingAfter` pagination param are camelCase; `run_id` /
  // `chat_session_id` are snake_case domain fields.
  router.get("/documents", rateLimit(120), requirePermission("documents", "read"), async (c) => {
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

    const page = await listDocumentsForActor(scope, actor, filters, c.get("permissions"));
    return c.json(page);
  });

  // GET /api/documents/:id — metadata DTO. Token-minting route (the single GET
  // mints the signed `preview_url`), so it is rate-limited like the others.
  router.get(
    "/documents/:id",
    rateLimit(120),
    requirePermission("documents", "read"),
    async (c) => {
      const scope = getAppScope(c);
      const actor = getActor(c);
      const resolved = await getDocumentForActor(
        scope,
        actor,
        c.req.param("id")!,
        c.get("permissions"),
      );
      if (!resolved) throw notFound("Document not found");
      return c.json(
        toDocumentDto(resolved.row, actor, resolved.capabilities, { mintPreview: true }),
      );
    },
  );

  // GET /api/documents/:id/content — download the bytes. Gated by the derived
  // `downloadable` flag (a user upload is served only to its creator). 307 to a
  // presigned GET when storage supports it (S3 with a public endpoint), else
  // proxy-stream. Content-Disposition: attachment.
  router.get(
    "/documents/:id/content",
    rateLimit(120),
    requirePermission("documents", "read"),
    async (c) => {
      const scope = getAppScope(c);
      const actor = getActor(c);
      const resolved = await getDocumentForActor(scope, actor, c.req.param("id")!);
      if (!resolved) throw notFound("Document not found");
      if (!resolved.capabilities.download) {
        throw forbidden("This document is not downloadable by the current actor");
      }
      const { row } = resolved;

      // RFC 9530 representation digest of the stored bytes — exposed only when
      // the caller has the `metadata` capability (so a private upload's hash is
      // never disclosed to a non-creator; download already implies metadata
      // for these).
      const reprDigest = resolved.capabilities.metadata ? reprDigestSha256(row.sha256) : undefined;

      const parsed = parseStorageKey(row.storageKey);
      const presigned = parsed
        ? await createDownloadUrl(parsed.bucket, parsed.path, {
            filename: row.name,
            contentType: row.mime,
          })
        : null;
      if (presigned) {
        // The presigned GET serves the bytes from the blob store (we can't set
        // headers on that response), but carry the digest on the 307 so a
        // client that inspects the redirect still learns the authoritative hash.
        if (reprDigest) c.header("Repr-Digest", reprDigest);
        return c.redirect(presigned, 307);
      }

      const stream = await streamDocumentContent(row.storageKey);
      if (!stream) throw notFound("Document content not found");
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": row.mime,
          // The MIME is agent/uploader-controlled — forbid content-type
          // sniffing so a mislabelled body can never be reinterpreted as
          // active content (S3). Attachment disposition already prevents
          // inline rendering.
          "X-Content-Type-Options": "nosniff",
          "Content-Length": String(row.size),
          "Content-Disposition": attachmentDisposition(row.name),
          "Cache-Control": "private, no-store",
          ...(reprDigest ? { "Repr-Digest": reprDigest } : {}),
        },
      });
    },
  );

  // DELETE /api/documents/:id — allowed for a caller with the `documents:delete`
  // permission (owner/admin) OR the document's own creator.
  router.delete("/documents/:id", rateLimit(60), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(
      scope,
      actor,
      c.req.param("id")!,
      c.get("permissions"),
    );
    if (!resolved) throw notFound("Document not found");
    const { row } = resolved;

    if (!resolved.capabilities.delete) {
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

  // POST /api/documents/:id/keep — "keep"/pin: clear the document's retention
  // deadline (`expires_at = NULL`) so the expiry GC never sweeps it. Same
  // authorization as delete (the `documents:delete` permission OR the document's
  // own creator). Idempotent — pinning an already-permanent document is a no-op
  // that returns 200 with the (unchanged) document. Returns the updated DTO.
  router.post("/documents/:id/keep", rateLimit(60), async (c) => {
    const scope = getAppScope(c);
    const actor = getActor(c);
    const resolved = await getDocumentForActor(
      scope,
      actor,
      c.req.param("id")!,
      c.get("permissions"),
    );
    if (!resolved) throw notFound("Document not found");
    const { row } = resolved;

    if (!resolved.capabilities.keep) {
      throw forbidden("Only the document creator or an admin can keep this document");
    }

    const wasExpiring = row.expiresAt !== null;
    const updated = await clearDocumentExpiry(scope, row.id);
    // Only audit an actual change (a no-op pin of an already-permanent document
    // writes no audit event).
    if (wasExpiring) {
      await recordAuditFromContext(c, {
        action: "document.kept",
        resourceType: "document",
        resourceId: row.id,
        before: { expiresAt: row.expiresAt?.toISOString() ?? null },
        after: { expiresAt: null },
      });
    }
    return c.json(toDocumentDto(updated, actor, resolved.capabilities));
  });

  return router;
}

/**
 * Cookie-less document preview router — MOUNTED OUTSIDE `/api`, BEFORE the auth
 * pipeline, so no cookie/API-key/org/app middleware ever touches it. Serves a
 * previewable document in maximum isolation, branching on its
 * {@link previewKind}:
 *
 *  - `html` — untrusted agent-generated ACTIVE content: a strict CSP header
 *    whose `sandbox allow-scripts` puts the document in an OPAQUE origin (no
 *    first-party origin to act on, and no navigation of the TOP-LEVEL browsing
 *    context — otherwise a preview opened in its own tab could steer that tab
 *    to a real `/login` and phish; a nested frame may still navigate ITSELF,
 *    see {@link buildPreviewCsp}), plus an
 *    injected parse-time `<meta>` CSP carrying the same policy minus `sandbox`,
 *    which a meta context ignores (covers the relative-URL / `srcdoc` bypass a
 *    header alone can miss), COOP `same-origin`, the full `Permissions-Policy`.
 *    Served as ACTIVE html only where execution cannot reach the app session —
 *    on a dedicated `USERCONTENT_URL` origin, or (same-origin mode) inside the
 *    SPA's opaque `sandbox="allow-scripts"` iframe. Any other loading context,
 *    a top-level navigation above all, degrades to inert `text/plain` source.
 *    See {@link mayServeActiveHtml}.
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
    // container (its `download` capability is always true), so this gate is a
    // no-op there.
    if (row.purpose === "user_upload") {
      const tokenActor = actorFromIds(payload.u ?? null, payload.eu ?? null);
      if (!tokenActor || !getDocumentCapabilities(row, tokenActor, { visible: true }).download) {
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
      // Active content — the full hardened treatment. Buffer-and-transform:
      // read the whole (capped) body, inject the meta CSP as the first child
      // of <head>, serve. Simple + correct over regex streaming.
      //
      // …but ONLY when this request is a context where executing the script
      // cannot reach the app's session. In same-origin mode (no
      // USERCONTENT_URL — the OSS default) that means the SPA's
      // `sandbox="allow-scripts"` iframe and nothing else; a top-level
      // navigation to the same absolute `preview_url` would run agent script
      // on APP_URL itself. See `mayServeActiveHtml`.
      const html = await new Response(stream).text();
      const active = mayServeActiveHtml({
        separateOrigin: Boolean(env.USERCONTENT_URL),
        secFetchDest: c.req.header("Sec-Fetch-Dest") ?? null,
      });
      const commonHeaders = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "Cache-Control": "private, no-store",
        // On the active branch the CSP sandbox gives the document an opaque
        // origin, which `same-origin` can never match — so it lands in its own
        // browsing-context group. Stricter than the intended pairing, not a
        // regression; keep it (the inert branch still matches normally).
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": corp,
        // The representation depends on the request header — say so, even
        // though `no-store` already forbids caching.
        Vary: "Sec-Fetch-Dest",
      };

      if (!active) {
        // Same bytes, relabelled: `text/plain` + `nosniff` means the browser
        // renders the markup as source and never parses it as a document, so
        // nothing executes in the app origin. `default-src 'none'` on top.
        return new Response(html, {
          status: 200,
          headers: {
            ...commonHeaders,
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Security-Policy": buildInertPreviewCsp(appOrigin),
            "Content-Disposition": "inline",
          },
        });
      }

      // Two copies of one policy: the header carries `sandbox allow-scripts`
      // (opaque origin — the only thing here that stops agent script from
      // navigating the top-level browsing context to a real `/login`), the meta
      // copy omits it because `sandbox` is ignored in a meta context. They are
      // NOT interchangeable — see `buildPreviewCsp`.
      const csp = buildPreviewCsp(appOrigin);
      const body = injectMetaCsp(html, csp.meta);
      return new Response(body, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp.header,
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
