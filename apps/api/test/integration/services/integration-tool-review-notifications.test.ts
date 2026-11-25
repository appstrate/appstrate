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
import { seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";

const ID = "@acme/files";

const tool = (name: string, description = `Tool ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

describe("tool review notifications", () => {
  let ctx: TestContext;

  const list = (tools: Tool[], connectionId: string | null = null) =>
    recordToolSnapshot({ orgId: ctx.orgId, packageId: ID, connectionId, tools, truncated: false });

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
    const viewer = await memberContext(ctx, "member", "viewer");
    const active = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    await seedSpacePackage(active.id, ID);
    const inactive = await seedSpace({ orgId: ctx.orgId, visibility: "private" });

    await list([tool("read_file"), tool("write_file")]);

    expect(await notices()).toEqual(
      [
        `${ctx.defaultSpaceId}:${ctx.user.id}`,
        `${ctx.defaultSpaceId}:${holder.user.id}`,
        `${active.id}:${ctx.user.id}`,
      ].sort(),
    );
    expect(await notices()).not.toContain(`${ctx.defaultSpaceId}:${viewer.user.id}`);
    expect((await notices()).some((n) => n.startsWith(inactive.id))).toBe(false);
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

  it("stays silent when only declared tools appear or change", async () => {
    await seed();
    await list([tool("read_file")]);
    await list([tool("read_file", "changed")]);
    expect(await notices()).toEqual([]);
  });

  it("stays silent on an open catalog", async () => {
    await seed({ allow_undeclared_tools: true });
    await list([tool("read_file"), tool("write_file")]);
    expect(await notices()).toEqual([]);
  });

  it("reaches only the spaces its connection serves", async () => {
    await seed();
    const other = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    await seedSpacePackage(other.id, ID);
    const connectionId = await seedProxyConnection(ctx, ID, "default", {});

    await list([tool("write_file")], connectionId);

    expect(await notices()).toEqual([`${ctx.defaultSpaceId}:${ctx.user.id}`]);
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
