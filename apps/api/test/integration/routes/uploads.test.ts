// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for upload creation:
 *
 *   POST /api/uploads — create an upload descriptor (signed URL + DB row)
 *
 * The FS content sink (PUT /api/uploads/_content) is covered separately in
 * uploads-content.test.ts. This file pins the descriptor-creation contract:
 * the resource shape, validation, and the audit trail every state-changing
 * route must leave (upload.created).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { auditEvents } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("POST /api/uploads", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "uplorg" });
  });

  it("creates an upload descriptor and persists an upload.created audit event", async () => {
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "report.pdf", size: 1024, mime: "application/pdf" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { object?: string; id?: string; url?: string };
    expect(body.object).toBe("upload");
    expect(body.id).toBeString();
    expect(body.url).toBeString();

    // The creation leaves an audit trail (upload.created, actor = caller).
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "upload.created"), eq(auditEvents.resourceId, body.id!)));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.orgId).toBe(ctx.orgId);
    expect(auditRows[0]!.applicationId).toBe(ctx.defaultAppId);
    expect(auditRows[0]!.resourceType).toBe("upload");
    expect(auditRows[0]!.actorType).toBe("user");
    expect(auditRows[0]!.actorId).toBe(ctx.user.id);
    expect(auditRows[0]!.after).toEqual({
      name: "report.pdf",
      size: 1024,
      mime: "application/pdf",
    });
  });

  it("returns an app-domain proxy upload URL when no public storage endpoint is configured", async () => {
    // Both storage backends must sign the platform sink URL here: filesystem
    // always does, and S3 does whenever S3_PUBLIC_ENDPOINT is unset (proxy
    // mode, issue #829) — the test env never sets a public endpoint, so a
    // presigned direct-to-bucket URL leaking through would regress the
    // "blob store stays private" contract.
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "clip.bin", size: 64, mime: "application/octet-stream" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toContain("/api/uploads/_content?token=");
  });

  it("rejects an invalid body with 400 and records no audit event", async () => {
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "report.pdf" }),
    });

    expect(res.status).toBe(400);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
    expect(rows.filter((r) => r.action === "upload.created")).toHaveLength(0);
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "report.pdf", size: 1024, mime: "application/pdf" }),
    });
    expect(res.status).toBe(401);
  });
});
