// SPDX-License-Identifier: Apache-2.0

/**
 * Constraints of migration 0115: the snapshot's one-row-per-target index (NULL connection
 * included), the approvals' per-fingerprint uniqueness, the blocks' per-tool uniqueness, the
 * composite space/org FK, and the `integration_tools_review` notification kind with its
 * one-unread-per-(space, recipient, package) index.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { findCause } from "@appstrate/core/error-cause";
import {
  integrationToolSnapshots,
  notifications,
  spaceIntegrationToolApprovals,
  spaceIntegrationToolBlocks,
} from "@appstrate/db/schema";
import { db, truncateAll } from "../helpers/db.ts";
import { createTestContext, type TestContext } from "../helpers/auth.ts";
import { seedAgent } from "../helpers/seed.ts";

/** Resolves to the violated constraint's SQLSTATE and name (both drivers wrap the error). */
async function violation(run: Promise<unknown>): Promise<{ code: string; name: string }> {
  try {
    await run;
  } catch (error) {
    const cause = findCause(error, (c) => typeof c.code === "string" && c.code.startsWith("23"));
    if (cause)
      return {
        code: cause.code as string,
        name: (cause.constraint_name ?? cause.constraint) as string,
      };
    throw error;
  }
  throw new Error("expected a constraint violation");
}

describe("integration tool policy schema (migration 0115)", () => {
  let ctx: TestContext;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    packageId = (await seedAgent({ orgId: ctx.orgId, id: "@testorg/remote", type: "integration" }))
      .id;
  });

  it("keeps one snapshot per (org, package) when the connection is NULL", async () => {
    const row = { orgId: ctx.orgId, packageId, connectionId: null };
    await db.insert(integrationToolSnapshots).values(row);
    expect(await violation(db.insert(integrationToolSnapshots).values(row))).toEqual({
      code: "23505",
      name: "uq_integration_tool_snapshots_target",
    });
  });

  it("allows several fingerprints per tool but not the same one twice", async () => {
    const base = {
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId,
      toolName: "send",
      definition: { name: "send" },
    };
    await db.insert(spaceIntegrationToolApprovals).values({ ...base, fingerprint: "a" });
    await db.insert(spaceIntegrationToolApprovals).values({ ...base, fingerprint: "b" });
    expect(
      await violation(
        db.insert(spaceIntegrationToolApprovals).values({ ...base, fingerprint: "a" }),
      ),
    ).toEqual({ code: "23505", name: "uq_space_integration_tool_approvals" });
  });

  it("blocks a tool once per space and package", async () => {
    const row = { spaceId: ctx.defaultSpaceId, orgId: ctx.orgId, packageId, toolName: "send" };
    await db.insert(spaceIntegrationToolBlocks).values(row);
    expect(await violation(db.insert(spaceIntegrationToolBlocks).values(row))).toEqual({
      code: "23505",
      name: "uq_space_integration_tool_blocks",
    });
  });

  it("refuses a policy row whose space belongs to another organization", async () => {
    const other = await createTestContext({ email: "other@example.com", orgSlug: "other-org" });
    expect(
      await violation(
        db.insert(spaceIntegrationToolBlocks).values({
          spaceId: other.defaultSpaceId,
          orgId: ctx.orgId,
          packageId,
          toolName: "send",
        }),
      ),
    ).toEqual({ code: "23503", name: "space_integration_tool_blocks_space_org_fk" });
  });

  describe("integration_tools_review notifications", () => {
    const review = () => ({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      recipientType: "user" as const,
      recipientId: ctx.user.id,
      type: "integration_tools_review" as const,
      payload: { packageId, display_name: "Remote" },
    });

    it("gives a second package its own unread notice", async () => {
      await db.insert(notifications).values(review());
      await db
        .insert(notifications)
        .values({ ...review(), payload: { packageId: "@testorg/other", display_name: "Other" } });
    });
  });
});
