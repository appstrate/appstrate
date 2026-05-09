// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `recordAudit` — the append-only audit log helper.
 *
 * Pins the contract callers depend on:
 *   - rows are written with all provided fields, including JSONB before/after
 *   - rows are scoped to the calling org (FK to organizations)
 *   - the helper is best-effort: a malformed input never throws
 *   - cross-org reads do not leak rows from other orgs
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { auditEvents } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { recordAudit } from "../../../src/services/audit.ts";

describe("recordAudit", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("inserts a row with every provided field", async () => {
    const ctx = await createTestContext({ orgSlug: "audit-write" });

    await recordAudit({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actorType: "user",
      actorId: ctx.user.id,
      action: "connection.created",
      resourceType: "connection",
      resourceId: "conn_abc",
      before: null,
      after: { providerId: "gmail", scope: "read" },
      ip: "203.0.113.7",
      userAgent: "test-agent/1.0",
      requestId: "req_42",
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.applicationId).toBe(ctx.defaultAppId);
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe(ctx.user.id);
    expect(row.action).toBe("connection.created");
    expect(row.resourceType).toBe("connection");
    expect(row.resourceId).toBe("conn_abc");
    expect(row.before).toBeNull();
    expect(row.after).toEqual({ providerId: "gmail", scope: "read" });
    expect(row.ip).toBe("203.0.113.7");
    expect(row.userAgent).toBe("test-agent/1.0");
    expect(row.requestId).toBe("req_42");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips JSONB before/after diffs", async () => {
    const ctx = await createTestContext({ orgSlug: "audit-jsonb" });
    const before = { name: "old", scopes: ["a", "b"], nested: { count: 1 } };
    const after = { name: "new", scopes: ["a", "b", "c"], nested: { count: 2 } };

    await recordAudit({
      orgId: ctx.orgId,
      actorType: "user",
      actorId: ctx.user.id,
      action: "api_key.rotated",
      resourceType: "api_key",
      resourceId: "key_42",
      before,
      after,
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual(before);
    expect(rows[0]!.after).toEqual(after);
  });

  it("defaults optional fields to null when omitted", async () => {
    const ctx = await createTestContext({ orgSlug: "audit-nulls" });

    await recordAudit({
      orgId: ctx.orgId,
      actorType: "system",
      action: "scheduler.fired",
      resourceType: "schedule",
    });

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.applicationId).toBeNull();
    expect(row.actorId).toBeNull();
    expect(row.resourceId).toBeNull();
    expect(row.before).toBeNull();
    expect(row.after).toBeNull();
    expect(row.ip).toBeNull();
    expect(row.userAgent).toBeNull();
    expect(row.requestId).toBeNull();
  });

  it("isolates rows per org — a query scoped to org A never sees org B's rows", async () => {
    const ctxA = await createTestContext({ orgSlug: "audit-a" });
    const ctxB = await createTestContext({ orgSlug: "audit-b" });

    await recordAudit({
      orgId: ctxA.orgId,
      actorType: "user",
      actorId: ctxA.user.id,
      action: "connection.created",
      resourceType: "connection",
      resourceId: "conn_a",
    });
    await recordAudit({
      orgId: ctxB.orgId,
      actorType: "user",
      actorId: ctxB.user.id,
      action: "connection.created",
      resourceType: "connection",
      resourceId: "conn_b",
    });

    const aRows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctxA.orgId));
    const bRows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctxB.orgId));
    expect(aRows.map((r) => r.resourceId)).toEqual(["conn_a"]);
    expect(bRows.map((r) => r.resourceId)).toEqual(["conn_b"]);
  });

  it("is best-effort: a bad input never throws (caller's mutation is unaffected)", async () => {
    // orgId is required (FK NOT NULL). A non-existent org id violates the
    // FK; the helper catches and swallows the error so callers don't see it.
    await expect(
      recordAudit({
        orgId: "00000000-0000-0000-0000-000000000000",
        actorType: "system",
        action: "x",
        resourceType: "y",
      }),
    ).resolves.toBeUndefined();
  });

  it("supports lookups by (resourceType, resourceId) — index-backed query path", async () => {
    const ctx = await createTestContext({ orgSlug: "audit-lookup" });

    for (let i = 0; i < 3; i++) {
      await recordAudit({
        orgId: ctx.orgId,
        actorType: "user",
        actorId: ctx.user.id,
        action: i === 0 ? "api_key.created" : "api_key.used",
        resourceType: "api_key",
        resourceId: "key_lookup",
      });
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, ctx.orgId),
          eq(auditEvents.resourceType, "api_key"),
          eq(auditEvents.resourceId, "key_lookup"),
        ),
      );
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.action === "api_key.created")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "api_key.used")).toHaveLength(2);
  });
});
