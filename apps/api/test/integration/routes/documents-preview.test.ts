// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for Phase 4 — the hardened, cookie-less document preview.
 *
 * The security assertions are the deliverable:
 *  - the preview route (`GET /preview/documents/:id`) serves a document ONLY with
 *    a valid, unexpired, doc-bound signed token. HTML (active content) gets the
 *    full hardened header set (strict CSP, nosniff, no-referrer,
 *    Permissions-Policy, no Set-Cookie) plus a parse-time `<meta>` CSP injected
 *    as the FIRST child of `<head>`; the inert kinds (image / pdf / text) stream
 *    byte-for-byte with an `inline` disposition, `nosniff`, and a minimal
 *    `default-src 'none'` CSP — text ALWAYS relabelled `text/plain`;
 *  - expired / cross-document / missing tokens 401; non-previewable / missing /
 *    deleted docs (and SVG — active content, excluded) 404; oversized docs 413; a
 *    session cookie is neither required nor an authorization (token-only), and a
 *    valid session WITHOUT a token is 401;
 *  - `GET /api/documents/:id` mints `preview_url` + `preview_kind` for every
 *    previewable kind, on the `USERCONTENT_URL` origin when set.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { documents } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { getEnv, _resetCacheForTesting } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser } from "../../helpers/seed.ts";
import { signPreviewToken, PREVIEW_MAX_BYTES } from "../../../src/services/document-preview.ts";

const app = getTestApp();

async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  process.env[key] = value;
  _resetCacheForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    _resetCacheForTesting();
  }
}

const HTML = `<!doctype html><html><head><title>hi</title></head><body><p>hello</p></body></html>`;

/** Seed a document row + write its bytes to the durable documents bucket. */
async function seedDoc(
  ctx: TestContext,
  opts: {
    mime?: string;
    body?: string;
    size?: number;
    orgId?: string;
    purpose?: "agent_output" | "user_upload";
    userId?: string | null;
    endUserId?: string | null;
  } = {},
): Promise<string> {
  const docId = `doc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const bytes = new TextEncoder().encode(opts.body ?? HTML);
  const safeName = "page.html";
  const storagePath = `${ctx.defaultAppId}/${docId}/${safeName}`;
  await uploadStream("documents", storagePath, new Blob([bytes]).stream(), { exclusive: true });
  await db.insert(documents).values({
    id: docId,
    orgId: opts.orgId ?? ctx.orgId,
    applicationId: ctx.defaultAppId,
    purpose: opts.purpose ?? "agent_output",
    userId: opts.userId ?? null,
    endUserId: opts.endUserId ?? null,
    storageKey: `documents/${storagePath}`,
    name: safeName,
    mime: opts.mime ?? "text/html",
    size: opts.size ?? bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
  return docId;
}

function mintToken(
  docId: string,
  orgId: string,
  expSeconds: number,
  creator: { u?: string | null; eu?: string | null } = {},
): string {
  return signPreviewToken(
    { d: docId, o: orgId, e: expSeconds, ...creator },
    getEnv().UPLOAD_SIGNING_SECRET,
  );
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("GET /preview/documents/:id — hardened HTML preview", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "previeworg" });
  });

  it("serves the HTML with the exact hardened header set + injected meta CSP (no cookie)", async () => {
    const docId = await seedDoc(ctx);
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);

    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);

    const appOrigin = new URL(getEnv().APP_URL).origin;
    const expectedCsp =
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ` +
      `img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; ` +
      `form-action 'none'; frame-ancestors ${appOrigin}; base-uri 'none'`;

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(expectedCsp);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // NEVER sets a cookie.
    expect(res.headers.get("set-cookie")).toBeNull();

    const body = await res.text();
    // Meta CSP injected as the FIRST child of <head>.
    expect(body).toContain(`<head><meta http-equiv="Content-Security-Policy" content="`);
    const headIdx = body.indexOf("<head>");
    const metaIdx = body.indexOf("<meta http-equiv=");
    const titleIdx = body.indexOf("<title>");
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBe(headIdx + "<head>".length);
    expect(metaIdx).toBeLessThan(titleIdx); // meta precedes the original head content
    // The injected meta CSP duplicates the header policy.
    expect(body).toContain(`content="${expectedCsp}"`);
  });

  it("ignores a session cookie (token-only): a cookie present does not change the 200", async () => {
    const docId = await seedDoc(ctx);
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`, {
      headers: { Cookie: ctx.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a valid session WITHOUT a token (no cookie auth fallback): 401", async () => {
    const docId = await seedDoc(ctx);
    const res = await app.request(`/preview/documents/${docId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token: 401 (clock-free — craft an already-past exp)", async () => {
    const docId = await seedDoc(ctx);
    const token = mintToken(docId, ctx.orgId, nowSec() - 1);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token minted for document A replayed on document B: 401", async () => {
    const docA = await seedDoc(ctx);
    const docB = await seedDoc(ctx);
    const tokenA = mintToken(docA, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docB}?t=${encodeURIComponent(tokenA)}`);
    expect(res.status).toBe(401);
  });

  it("rejects a garbage token: 401", async () => {
    const docId = await seedDoc(ctx);
    const res = await app.request(`/preview/documents/${docId}?t=not-a-real-token`);
    expect(res.status).toBe(401);
  });

  it("404s a non-previewable document even with a valid token", async () => {
    const docId = await seedDoc(ctx, { mime: "application/octet-stream" });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
  });

  it("404s an SVG (active content, deliberately excluded from preview)", async () => {
    const docId = await seedDoc(ctx, { mime: "image/svg+xml" });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
  });

  it("streams an image inline with its stored mime + nosniff + inert CSP (no meta injection)", async () => {
    const bytes = "\x89PNG\r\n\x1a\nfake-png-bytes";
    const docId = await seedDoc(ctx, { mime: "image/png", body: bytes });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);

    const appOrigin = new URL(getEnv().APP_URL).origin;
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      `default-src 'none'; frame-ancestors ${appOrigin}`,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    // Bytes streamed verbatim — no <meta> CSP injection on the inert path.
    const body = await res.text();
    expect(body).toBe(bytes);
    expect(body).not.toContain("Content-Security-Policy");
  });

  it("serves application/pdf inline with nosniff + inert CSP (native-viewer path)", async () => {
    const docId = await seedDoc(ctx, { mime: "application/pdf", body: "%PDF-1.7 fake" });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("ALWAYS relabels a text kind as text/plain (never the stored text/markdown)", async () => {
    const md = "# Title\n\n<script>alert(1)</script>\n";
    const docId = await seedDoc(ctx, { mime: "text/markdown", body: md });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    // Relabelled — never served as text/markdown (kills the markdown→HTML sniff).
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    // Client-side render fetches this URL — the global CORS middleware emits an
    // Access-Control-Allow-Origin so the SPA (potentially on a different origin
    // than USERCONTENT_URL) may read it.
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    // Bytes verbatim (the `<script>` is inert text, not injected active content).
    expect(await res.text()).toBe(md);
  });

  it("404s a deleted / unknown document (token cannot resurrect it)", async () => {
    const docId = await seedDoc(ctx);
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    await db.delete(documents).where(eq(documents.id, docId));
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
  });

  it("404s a token whose org does not match the document's org", async () => {
    const docId = await seedDoc(ctx);
    const other = await createTestContext({ orgSlug: "otherpreview" });
    const token = mintToken(docId, other.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
  });

  it("413s a document larger than the preview cap", async () => {
    const docId = await seedDoc(ctx, { size: PREVIEW_MAX_BYTES + 1 });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(413);
  });

  // S1 defense-in-depth: a `user_upload` is creator-only content, so its
  // preview is refused unless the token's bound minting actor is the document's
  // creator — even a token that verifies (was signed with the real secret).
  it("refuses a user_upload preview whose token carries NO creator binding (401)", async () => {
    const docId = await seedDoc(ctx, { purpose: "user_upload", userId: ctx.user.id });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300); // no u/eu bound
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it("refuses a user_upload preview whose token is bound to a DIFFERENT user (401)", async () => {
    const docId = await seedDoc(ctx, { purpose: "user_upload", userId: ctx.user.id });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300, { u: crypto.randomUUID() });
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it("serves a user_upload preview when the token is bound to the creator (200)", async () => {
    const docId = await seedDoc(ctx, { purpose: "user_upload", userId: ctx.user.id });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300, { u: ctx.user.id });
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  // Same S1 gate down the `eu` (end-user creator) branch of actorFromIds — an
  // end-user's own upload, previewable only when the token binds THAT end-user.
  it("refuses an end-user user_upload preview whose token is bound to a DIFFERENT end-user (401)", async () => {
    const eu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const docId = await seedDoc(ctx, { purpose: "user_upload", endUserId: eu.id });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300, { eu: `eu_${crypto.randomUUID()}` });
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  it("serves an end-user user_upload preview when the token is bound to that end-user (200)", async () => {
    const eu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const docId = await seedDoc(ctx, { purpose: "user_upload", endUserId: eu.id });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300, { eu: eu.id });
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  it("leaves agent_output previews unaffected by the creator gate (200 without a binding)", async () => {
    const docId = await seedDoc(ctx, { purpose: "agent_output" });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300); // no binding
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  it("serves cross-origin CORP when USERCONTENT_URL is configured", async () => {
    const docId = await seedDoc(ctx);
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    await withEnv("USERCONTENT_URL", "https://usercontent.example", async () => {
      const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    });
  });
});

describe("GET /api/documents/:id — preview_url minting", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "minturl" });
  });

  it("mints preview_url + preview_kind=html for a text/html document, pointing at the preview route", async () => {
    const docId = await seedDoc(ctx, { mime: "text/html" });
    const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      preview_url: string | null;
      preview_kind: string | null;
      previewable: boolean;
    };
    expect(dto.previewable).toBe(true);
    expect(dto.preview_kind).toBe("html");
    expect(dto.preview_url).toBeTruthy();
    const url = new URL(dto.preview_url!);
    expect(url.pathname).toBe(`/preview/documents/${docId}`);
    expect(url.searchParams.get("t")).toBeTruthy();
    expect(url.origin).toBe(new URL(getEnv().APP_URL).origin);
  });

  it("mints preview_url + preview_kind for each non-HTML previewable kind", async () => {
    for (const [mime, kind] of [
      ["application/pdf", "pdf"],
      ["image/png", "image"],
      ["text/csv", "text"],
    ] as const) {
      const docId = await seedDoc(ctx, { mime });
      const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
      const dto = (await res.json()) as { preview_url: string | null; preview_kind: string | null };
      expect(dto.preview_kind).toBe(kind);
      expect(dto.preview_url).toBeTruthy();
    }
  });

  it("returns preview_url null + preview_kind null for a non-previewable document", async () => {
    const docId = await seedDoc(ctx, { mime: "application/octet-stream" });
    const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
    const dto = (await res.json()) as {
      preview_url: string | null;
      preview_kind: string | null;
      previewable: boolean;
    };
    expect(dto.previewable).toBe(false);
    expect(dto.preview_kind).toBeNull();
    expect(dto.preview_url).toBeNull();
  });

  it("mints preview_url on the USERCONTENT_URL origin when set", async () => {
    const docId = await seedDoc(ctx, { mime: "text/html" });
    await withEnv("USERCONTENT_URL", "https://usercontent.example", async () => {
      const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
      const dto = (await res.json()) as { preview_url: string | null };
      expect(dto.preview_url).toBeTruthy();
      const url = new URL(dto.preview_url!);
      expect(url.origin).toBe("https://usercontent.example");
      expect(url.pathname).toBe(`/preview/documents/${docId}`);
    });
  });
});
