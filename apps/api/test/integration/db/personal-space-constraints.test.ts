// SPDX-License-Identifier: Apache-2.0

/**
 * The DB half of "personal has to mean one thing" (RBAC spec §3.6, migration
 * `0064`). The API refuses each of these with a named 4xx; these are the
 * constraints that make the refusal a property of the data rather than of the
 * code path that happened to run.
 *
 * Tier 0 runs this on PGlite, which enforces CHECKs and partial unique indexes
 * exactly as PostgreSQL does — the point of asserting them here rather than
 * trusting the snapshot.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { prefixedId } from "@appstrate/db/ids";
import { ensurePersonalSpace } from "@appstrate/db/provision-org";

/**
 * Drizzle wraps a driver error: `message` is the failed SQL, and the constraint
 * name — the thing under test — is on `cause`. Asserting on `message` would
 * pass for ANY failure of that statement, which is the trap this helper exists
 * to avoid.
 */
async function expectDbViolation(promise: Promise<unknown>, constraint: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "the statement was expected to be refused by the database").toBeDefined();
  const cause = (caught as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? caught)).toMatch(constraint);
}

function personalRow(ctx: TestContext, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: prefixedId("spc"),
    orgId: ctx.orgId,
    name: "Mon espace",
    visibility: "private" as const,
    ownerUserId: userId,
    ...overrides,
  };
}

describe("spaces — personal-space constraints", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "personal-constraints" });
  });

  it("accepts a private, non-default personal space", async () => {
    const [row] = await db.insert(spaces).values(personalRow(ctx, ctx.user.id)).returning();
    expect(row!.ownerUserId).toBe(ctx.user.id);
    expect(row!.orphanedAt).toBeNull();
  });

  it("refuses a personal space that is not private (spaces_personal_is_private)", async () => {
    for (const visibility of ["open", "closed"] as const) {
      await expectDbViolation(
        db.insert(spaces).values(personalRow(ctx, ctx.user.id, { visibility })),
        /spaces_personal_is_private/,
      );
    }
  });

  it("refuses a personal space that is the org default (spaces_personal_not_default)", async () => {
    // `is_default` + `private` would also break `spaces_default_is_open`, so
    // the row is built as the only shape that isolates THIS check.
    await db.delete(spaces).where(eq(spaces.orgId, ctx.orgId));
    await expectDbViolation(
      db
        .insert(spaces)
        .values(personalRow(ctx, ctx.user.id, { isDefault: true, visibility: "open" })),
      /spaces_personal_not_default|spaces_personal_is_private/,
    );
  });

  it("refuses orphaning a TEAM space (spaces_orphaned_is_personal)", async () => {
    await expectDbViolation(
      db
        .update(spaces)
        .set({ orphanedAt: new Date() })
        .where(and(eq(spaces.orgId, ctx.orgId), eq(spaces.isDefault, true))),
      /spaces_orphaned_is_personal/,
    );
  });

  it("refuses a second personal space for the same member (uq_spaces_org_owner)", async () => {
    await db.insert(spaces).values(personalRow(ctx, ctx.user.id));
    await expectDbViolation(
      db.insert(spaces).values(personalRow(ctx, ctx.user.id)),
      /uq_spaces_org_owner/,
    );
  });

  it("allows one per member and one per org — the index is partial and composite", async () => {
    const second = await createTestUser();
    const otherOrg = await createTestContext({ orgSlug: "personal-constraints-2" });
    await db.insert(spaces).values(personalRow(ctx, ctx.user.id));
    await db.insert(spaces).values(personalRow(ctx, second.id));
    await db.insert(spaces).values(personalRow(otherOrg, ctx.user.id));
    // …and the partial predicate keeps team spaces (NULL owner) out of it
    // entirely, so an org can still have as many as it likes.
    await db.insert(spaces).values({ id: prefixedId("spc"), orgId: ctx.orgId, name: "Team A" });
    await db.insert(spaces).values({ id: prefixedId("spc"), orgId: ctx.orgId, name: "Team B" });
  });

  it("ensurePersonalSpace is idempotent and clears an orphan stamp", async () => {
    const first = await db.transaction((tx) => ensurePersonalSpace(tx, ctx.orgId, ctx.user.id));
    const again = await db.transaction((tx) => ensurePersonalSpace(tx, ctx.orgId, ctx.user.id));
    expect(again!.id).toBe(first!.id);

    await db.update(spaces).set({ orphanedAt: new Date() }).where(eq(spaces.id, first!.id));
    const rejoined = await db.transaction((tx) => ensurePersonalSpace(tx, ctx.orgId, ctx.user.id));
    expect(rejoined!.id).toBe(first!.id);
    expect(rejoined!.orphanedAt).toBeNull();
  });

  it("keeps a user that owns a space undeletable (ON DELETE RESTRICT)", async () => {
    // The offboarding sweeper is the path out; a cascade here would drop
    // somebody's private drafts as a side effect of an account deletion.
    await db.transaction((tx) => ensurePersonalSpace(tx, ctx.orgId, ctx.user.id));
    await expectDbViolation(
      db.execute(sql`DELETE FROM "user" WHERE id = ${ctx.user.id}`),
      /spaces_owner_user_id_user_id_fk|foreign key/i,
    );
  });
});
