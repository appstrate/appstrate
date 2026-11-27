// SPDX-License-Identifier: Apache-2.0

/**
 * `integration_tools_review` notifications: who is asked to review the tools a remote
 * integration's server newly offers, written by `recordToolSnapshot` once its transaction commits.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { notifications, organizations } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { insertToolApprovals, tool, toolFingerprint } from "../../helpers/tool-policy.ts";
import { seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { drainAudits } from "../../../src/services/audit.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";

describe("tool review notifications", () => {
  let ctx: TestContext;

  /** The fan-out runs off the listing's path: flushed before anything reads its notices. */
  const list = async (tools: Tool[], connectionId: string | null = null) => {
    await recordToolSnapshot({
      orgId: ctx.orgId,
      packageId: ID,
      connectionId,
      tools,
      truncated: false,
    });
    await drainAudits(5000);
  };

  /** `space:user` pairs of the unread review notices. */
  const notices = async (): Promise<string[]> => {
    const rows = await db
      .select({ spaceId: notifications.spaceId, recipientId: notifications.recipientId })
      .from(notifications)
      .where(eq(notifications.type, "integration_tools_review"));
    return rows.map((r) => `${r.spaceId}:${r.recipientId}`).sort();
  };

  const seed = (extra: Record<string, unknown> = {}) =>
    seedProxyIntegration(ctx, {
      ...remoteIntegrationManifest({
        name: ID,
        displayName: "Files",
        tools_policy: { read_file: {} },
      }),
      ...extra,
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
  });

  it("asks each configure holder of the active spaces, and nobody else", async () => {
    await seed();
    const holder = await memberHolding(ctx, ["integrations:configure"]);
    await memberContext(ctx, "member", "viewer");
    const active = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    await seedSpacePackage(active.id, ID);
    await seedSpace({ orgId: ctx.orgId, visibility: "private" });

    await list([tool("read_file"), tool("write_file")]);

    expect(await notices()).toEqual(
      [
        `${ctx.defaultSpaceId}:${ctx.user.id}`,
        `${ctx.defaultSpaceId}:${holder.user.id}`,
        `${active.id}:${ctx.user.id}`,
      ].sort(),
    );
    const [row] = await db.select().from(notifications).limit(1);
    expect(row?.payload).toEqual({ packageId: ID, display_name: "Files" });
  });

  it("does not stack a second notice while the first is unread, and asks again once read", async () => {
    await seed();
    await list([tool("read_file"), tool("write_file")]);
    await list([tool("read_file"), tool("write_file"), tool("delete_file")]);
    expect(await notices()).toHaveLength(1);

    await db.update(notifications).set({ readAt: new Date() });
    await list([tool("read_file"), tool("write_file", "now different"), tool("delete_file")]);
    expect(await notices()).toHaveLength(2);
  });

  const silentCases: { title: string; run: () => Promise<void> }[] = [
    {
      title: "stays silent when only declared tools appear or change",
      run: async () => {
        await seed();
        await list([tool("read_file")]);
        await list([tool("read_file", "changed")]);
      },
    },
    {
      title: "stays silent on an open catalog",
      run: async () => {
        await seed({ allow_undeclared_tools: true });
        await list([tool("read_file"), tool("write_file")]);
      },
    },
    {
      title: "stays silent about a tool the space already approved at its current definition",
      run: async () => {
        await seed();
        await insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: ID }, [
          { toolName: "write_file", fingerprint: toolFingerprint("write_file") },
        ]);
        await list([tool("write_file")]);
      },
    },
  ];
  for (const c of silentCases) {
    it(c.title, async () => {
      await c.run();
      expect(await notices()).toEqual([]);
    });
  }

  it("reaches only the spaces its connection serves, and asks only the holders whose own usable connections include the snapshot's", async () => {
    await seed();
    const other = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    await seedSpacePackage(other.id, ID);
    const holder = await memberHolding(ctx, ["integrations:configure"]);
    const connectionId = await seedProxyConnection(ctx, ID, "default", {});

    await list([tool("write_file")], connectionId);

    expect(await notices()).toEqual([`${ctx.defaultSpaceId}:${ctx.user.id}`]);
    expect(await notices()).not.toContain(`${ctx.defaultSpaceId}:${holder.user.id}`);
  });

  it("asks a personal space's owner, unless the operator cap took configure from them", async () => {
    await seed();
    const owner = await createTestUser();
    await addOrgMember(ctx.orgId, owner.id, "member");
    const personal = await seedSpace({
      orgId: ctx.orgId,
      ownerUserId: owner.id,
      visibility: "private",
    });
    await seedSpacePackage(personal.id, ID);

    await list([tool("write_file")]);
    expect(await notices()).toContain(`${personal.id}:${owner.id}`);

    await db.delete(notifications);
    await db
      .update(organizations)
      .set({ orgSettings: { personal_space_role: "operator" } })
      .where(eq(organizations.id, ctx.orgId));
    await list([tool("write_file", "changed")]);
    // `operator` holds no integrations:configure: the cap leaves nothing to review.
    expect(await notices()).not.toContain(`${personal.id}:${owner.id}`);
  });
});
