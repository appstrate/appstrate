// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0041` against the test database: a user-owned connection of a system or org client,
 * or of none, becomes org-scoped with its origin space and shares kept; an end user's row and a
 * space client's row (manual or legacy DCR) stay in their space; a label the owner already holds
 * at org scope is renamed; an admin pin in the origin space binds the same connection; each
 * organization is widened and checked in a transaction of its own; a second run widens nothing.
 * The widening itself is `widenConnectionsToOrgScope`'s.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnections,
  integrationOauthClients,
  integrationPins,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { runWidenConnectionsToOrgScope } from "../migration/0041-widen-connections-to-org-scope.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../apps/api/test/helpers/auth.ts";
import {
  seedAgent,
  seedEndUser,
  seedPackage,
  seedSpace,
} from "../../apps/api/test/helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../apps/api/test/helpers/integration-manifests.ts";
import { activatePackage } from "../../apps/api/src/services/space-packages.ts";
import { resolveConnectionsForRun } from "../../apps/api/src/services/integration-connection-resolver.ts";

const INTEGRATION = "@mig0041/svc";
const AGENT = "@mig0041/agent";

const integrationManifest = localIntegrationManifest({
  name: INTEGRATION,
  serverName: "@mig0041/svc-server",
  version: "1.0.0",
  auths: {
    primary: {
      type: "api_key",
      authorizedUris: ["https://api.example.com/**"],
      credentialFields: ["api_key"],
      delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
    },
  },
  tools_policy: { search: {} },
});

const agentManifest = {
  name: AGENT,
  version: "1.0.0",
  type: "agent",
  schema_version: "0.2",
  display_name: "Widening agent",
  dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
  integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
};

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) =>
  runWidenConnectionsToOrgScope({ apply, out: (line) => lines.push(line) });

async function seedConnection(opts: {
  spaceId: string;
  orgId?: string;
  userId?: string;
  endUserId?: string;
  clientRef?: string | null;
  label?: string;
  shared?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: opts.orgId ?? ctx.orgId,
      spaceId: opts.spaceId,
      userId: opts.endUserId ? null : (opts.userId ?? ctx.user.id),
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
      clientRef: opts.clientRef ?? null,
      label: opts.label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      sharedSpaceIds: opts.shared ? [opts.spaceId] : [],
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function seedClient(spaceId: string | null, autoProvisioned = false): Promise<string> {
  const [row] = await db
    .insert(integrationOauthClients)
    .values({
      orgId: ctx.orgId,
      spaceId,
      integrationId: INTEGRATION,
      authKey: "primary",
      clientId: `cid-${crypto.randomUUID().slice(0, 8)}`,
      clientSecretEncrypted: "x",
      autoProvisioned,
    })
    .returning({ id: integrationOauthClients.id });
  return row!.id;
}

async function rowsOf(ids: string[]) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(inArray(integrationConnections.id, ids));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function scopeOf(id: string) {
  const [row] = await rowsOf([id]);
  return {
    spaceId: row!.spaceId,
    originSpaceId: row!.originSpaceId,
    sharedSpaceIds: row!.sharedSpaceIds,
  };
}

describe("0041 — connections widened to org scope", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0041" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      draftManifest: integrationManifest,
    });
  });

  it("widens system, org and client-less rows with origin and shares; leaves end-user and space-client rows", async () => {
    const space = ctx.defaultSpaceId;
    const system = await seedConnection({ spaceId: space, clientRef: "system-svc", shared: true });
    const org = await seedConnection({ spaceId: space, clientRef: await seedClient(null) });
    const none = await seedConnection({ spaceId: space });
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: space });
    const untouched = [
      await seedConnection({ spaceId: space, endUserId: endUser.id }),
      await seedConnection({ spaceId: space, clientRef: await seedClient(space) }),
      await seedConnection({ spaceId: space, clientRef: await seedClient(space, true) }),
    ];
    const before = await rowsOf(untouched);

    await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("to widen: 3");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(await scopeOf(system)).toEqual({
      spaceId: space,
      originSpaceId: null,
      sharedSpaceIds: [space],
    });

    lines.length = 0;
    await run(true);
    expect(lines.at(-1)).toBe("0041: APPLIED — committed.");
    expect(await scopeOf(system)).toEqual({
      spaceId: null,
      originSpaceId: space,
      sharedSpaceIds: [space],
    });
    for (const id of [org, none]) {
      expect(await scopeOf(id)).toEqual({
        spaceId: null,
        originSpaceId: space,
        sharedSpaceIds: [],
      });
    }
    expect(await rowsOf(untouched)).toEqual(before);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("to widen: 0");
    expect(lines).toContain("left to widen: 0");
  });

  it("renames a label its owner holds twice once both rows are org-scoped, and only then", async () => {
    const other = await seedSpace({ orgId: ctx.orgId });
    const colleague = await createTestUser();
    await addOrgMember(ctx.orgId, colleague.id, "member");
    const first = await seedConnection({ spaceId: ctx.defaultSpaceId, label: "Work" });
    const second = await seedConnection({ spaceId: other.id, label: "Work" });
    const colleagues = await seedConnection({
      spaceId: ctx.defaultSpaceId,
      userId: colleague.id,
      label: "Work",
    });

    await run(false);
    expect(lines).toContain("labels to rename: 1");

    lines.length = 0;
    const relabeled = (await run(true)).filter((r) => r.label !== r.previousLabel);
    expect(relabeled.map(({ label, previousLabel }) => ({ label, previousLabel }))).toEqual([
      { label: "Work (2)", previousLabel: "Work" },
    ]);
    const labelOf = Object.fromEntries(
      (await rowsOf([first, second, colleagues])).map((r) => [r.id, r.label]),
    );
    expect([labelOf[first], labelOf[second]].sort()).toEqual(["Work", "Work (2)"]);
    expect(labelOf[colleagues]).toBe("Work");
    expect(lines).toContain("owner labels held twice: 0");
  });

  it("an admin pin in the origin space binds the same connection after the widening", async () => {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest,
    });
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await activatePackage(scope, AGENT);
    await activatePackage(scope, INTEGRATION);
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const pinned = await seedConnection({
      spaceId: ctx.defaultSpaceId,
      userId: member.id,
      shared: true,
    });
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: [pinned],
    });
    const resolve = async () => {
      const { resolved, errors } = await resolveConnectionsForRun({
        agentManifest,
        packageId: AGENT,
        actor: { type: "user", id: ctx.user.id },
        scope,
      });
      expect(errors).toEqual([]);
      return resolved[INTEGRATION]?.map((c) => c.connectionId);
    };

    expect(await resolve()).toEqual([pinned]);
    await run(true);
    expect((await scopeOf(pinned)).spaceId).toBeNull();
    expect(await resolve()).toEqual([pinned]);
  });

  it("refuses, rolled back, a database holding an org-scoped row of a space client", async () => {
    const widenable = await seedConnection({ spaceId: ctx.defaultSpaceId });
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "acct-bad",
      orgId: ctx.orgId,
      spaceId: null,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      clientRef: await seedClient(ctx.defaultSpaceId),
      label: "Bad",
    });

    await expect(run(true)).rejects.toThrow(
      `a check after the widening is not 0 in org ${ctx.orgId}`,
    );
    expect(lines).toContain("  org-scoped rows of an end user or a space client: 1");
    expect((await scopeOf(widenable)).spaceId).toBe(ctx.defaultSpaceId);
  });

  it("refuses a dry run when an organization with nothing to widen fails a check", async () => {
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "acct-bad",
      orgId: ctx.orgId,
      spaceId: null,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      clientRef: await seedClient(ctx.defaultSpaceId),
      label: "Bad",
    });

    await expect(run(false)).rejects.toThrow("not 0 over the whole table");
    expect(lines).toContain("org-scoped rows of an end user or a space client: 1");
  });

  it("widens each organization in a transaction of its own, each rolled back on a dry run", async () => {
    const otherCtx = await createTestContext({ orgSlug: "mig0041-other" });
    const ours = await seedConnection({ spaceId: ctx.defaultSpaceId });
    const theirs = await seedConnection({
      orgId: otherCtx.orgId,
      spaceId: otherCtx.defaultSpaceId,
      userId: otherCtx.user.id,
    });

    await run(false);
    for (const orgId of [ctx.orgId, otherCtx.orgId]) {
      expect(lines).toContain(`org ${orgId}: widened 1, relabeled 0`);
    }
    expect(lines).toContain("connections widened: 2, relabeled: 0");
    expect((await scopeOf(ours)).spaceId).toBe(ctx.defaultSpaceId);
    expect((await scopeOf(theirs)).spaceId).toBe(otherCtx.defaultSpaceId);

    lines.length = 0;
    expect(await run(true)).toHaveLength(2);
    expect((await scopeOf(ours)).spaceId).toBeNull();
    expect((await scopeOf(theirs)).spaceId).toBeNull();
    expect(lines).toContain("left to widen: 0");
  });
});
