// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for Phase 4 — the hardened, cookie-less HTML preview.
 *
 * The security assertions are the deliverable:
 *  - the preview route (`GET /preview/documents/:id`) serves HTML ONLY with a
 *    valid, unexpired, doc-bound signed token, under the exact hardened header
 *    set (strict CSP, nosniff, no-referrer, Permissions-Policy, no Set-Cookie)
 *    plus a parse-time `<meta>` CSP injected as the FIRST child of `<head>`;
 *  - expired / cross-document / missing tokens 401; non-HTML / missing / deleted
 *    docs 404; oversized docs 413; a session cookie is neither required nor an
 *    authorization (token-only), and a valid session WITHOUT a token is 401;
 *  - `GET /api/documents/:id` mints `preview_url` only for `text/html`, on the
 *    `USERCONTENT_URL` origin when set.
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
    storageKey: `documents/${storagePath}`,
    name: safeName,
    mime: opts.mime ?? "text/html",
    size: opts.size ?? bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
  return docId;
}

function mintToken(docId: string, orgId: string, expSeconds: number): string {
  return signPreviewToken({ d: docId, o: orgId, e: expSeconds }, getEnv().UPLOAD_SIGNING_SECRET);
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

  it("404s a non-HTML document even with a valid token", async () => {
    const docId = await seedDoc(ctx, { mime: "application/pdf" });
    const token = mintToken(docId, ctx.orgId, nowSec() + 300);
    const res = await app.request(`/preview/documents/${docId}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
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

  it("mints preview_url for a text/html document, pointing at the preview route", async () => {
    const docId = await seedDoc(ctx, { mime: "text/html" });
    const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { preview_url: string | null };
    expect(dto.preview_url).toBeTruthy();
    const url = new URL(dto.preview_url!);
    expect(url.pathname).toBe(`/preview/documents/${docId}`);
    expect(url.searchParams.get("t")).toBeTruthy();
    expect(url.origin).toBe(new URL(getEnv().APP_URL).origin);
  });

  it("returns preview_url null for a non-HTML document", async () => {
    const docId = await seedDoc(ctx, { mime: "application/pdf" });
    const res = await app.request(`/api/documents/${docId}`, { headers: authHeaders(ctx) });
    const dto = (await res.json()) as { preview_url: string | null };
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
