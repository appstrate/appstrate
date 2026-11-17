// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/files/:id/excerpt` — the gallery tile excerpt. It is content, so it
 * answers exactly what `/content` answers on access (404 unreadable, 403 not
 * downloadable), and it reads a bounded prefix of the stored bytes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { files, runs } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  memberContext,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedSpace } from "../../helpers/seed.ts";
import { EXCERPT_READ_BYTES } from "../../../src/services/file-excerpt.ts";

const app = getTestApp();

/** Seed a file row in `spaceId`; its bytes are stored unless `body` is null. */
async function seedFile(
  ctx: TestContext,
  opts: {
    mime: string;
    body: string | null;
    name?: string;
    spaceId?: string;
    purpose?: "agent_output" | "user_upload";
    userId?: string;
    runId?: string;
  },
): Promise<string> {
  const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const spaceId = opts.spaceId ?? ctx.defaultSpaceId;
  const bytes = new TextEncoder().encode(opts.body ?? "");
  const storagePath = `${spaceId}/${id}/doc`;
  if (opts.body !== null) {
    await uploadStream("files", storagePath, new Blob([bytes]).stream(), { exclusive: true });
  }
  await db.insert(files).values({
    id,
    orgId: ctx.orgId,
    spaceId,
    purpose: opts.purpose ?? "agent_output",
    userId: opts.userId ?? ctx.user.id,
    runId: opts.runId ?? null,
    storageKey: `files/${storagePath}`,
    name: opts.name ?? "doc",
    mime: opts.mime,
    size: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
  return id;
}

function getExcerpt(id: string, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(app.request(`/api/files/${id}/excerpt`, { headers }));
}

describe("GET /api/files/:id/excerpt", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "excerptorg" });
  });

  it("returns the markdown text, privately cacheable per credential", async () => {
    const id = await seedFile(ctx, { mime: "text/markdown", body: "# Bilan\n\nTout **va** bien." });
    const res = await getExcerpt(id, authHeaders(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ excerpt: "Bilan\nTout va bien." });
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("vary")).toContain(
      "Cookie, Authorization, X-Org-Id, X-Space-Id, X-View-As, Appstrate-User",
    );
  });

  it("reads a .md stored as text/plain as markdown", async () => {
    const id = await seedFile(ctx, {
      mime: "text/plain",
      name: "notes.md",
      body: "# Notes\n**a**",
    });
    expect(await (await getExcerpt(id, authHeaders(ctx))).json()).toEqual({ excerpt: "Notes\na" });
  });

  it("returns the title and visible text of an html file", async () => {
    const id = await seedFile(ctx, {
      mime: "text/html; charset=utf-8",
      body: "<title>Page</title><script>alert(1)</script><p>Visible &amp; plain</p>",
    });
    const res = await getExcerpt(id, authHeaders(ctx));
    expect(await res.json()).toEqual({ excerpt: "Page\nVisible & plain" });
  });

  it("answers null for a type with no excerpt, without reading storage", async () => {
    // No stored object: a read would be a 404, so a 200 proves none happened.
    for (const mime of ["application/pdf", "image/png"]) {
      const id = await seedFile(ctx, { mime, body: null });
      const res = await getExcerpt(id, authHeaders(ctx));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ excerpt: null });
    }
  });

  it("reads only a bounded prefix of a large file", async () => {
    const big = await seedFile(ctx, {
      mime: "text/plain",
      body: "Début du journal\n" + "ligne de log\n".repeat(EXCERPT_READ_BYTES.text / 4),
    });
    const res = await getExcerpt(big, authHeaders(ctx));
    expect(res.status).toBe(200);
    const { excerpt } = (await res.json()) as { excerpt: string };
    expect(excerpt.startsWith("Début du journal\nligne de log")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);

    // Text that only starts past the read limit is never seen.
    const late = await seedFile(ctx, {
      mime: "text/html",
      body: `<style>${"x".repeat(EXCERPT_READ_BYTES.html)}</style><p>late</p>`,
    });
    expect(await (await getExcerpt(late, authHeaders(ctx))).json()).toEqual({ excerpt: null });
  });

  it("is 403 for another member's upload, like /content", async () => {
    const owner = await memberContext(ctx, "member", "builder");
    // `builder` reads every run of the space, so the upload resolves (not 404).
    const reader = await memberContext(ctx, "member", "builder");
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: owner.user.id,
      status: "success",
    });
    const id = await seedFile(ctx, {
      mime: "text/plain",
      body: "private notes",
      purpose: "user_upload",
      userId: owner.user.id,
      runId,
    });

    const res = await getExcerpt(id, authHeaders(reader));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const content = await app.request(`/api/files/${id}/content`, { headers: authHeaders(reader) });
    expect(content.status).toBe(403);

    expect(await (await getExcerpt(id, authHeaders(owner))).json()).toEqual({
      excerpt: "private notes",
    });
  });

  it("is 404 for a file of another space or another org", async () => {
    const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
    const inOtherSpace = await seedFile(ctx, {
      mime: "text/plain",
      body: "elsewhere",
      spaceId: otherSpace.id,
    });
    expect((await getExcerpt(inOtherSpace, authHeaders(ctx))).status).toBe(404);

    const stranger = await createTestContext({ orgSlug: "strangerorg" });
    const foreign = await seedFile(stranger, { mime: "text/plain", body: "foreign" });
    expect((await getExcerpt(foreign, authHeaders(ctx))).status).toBe(404);
  });
});
