// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0045` against the test database: a member owning several connections usable in a
 * space, exactly one of them made there, gets a member pin to it for each agent a run of theirs
 * there bound to it by default, and the schedules binding through that pin are listed; a dry run
 * writes nothing, a second `--apply` neither. Every other case is that one with a single condition
 * changed, and writes no pin.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  auditEvents,
  integrationConnections,
  integrationOrgDefaults,
  integrationPins,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { ConnectionResolutionSource } from "@appstrate/core/integration";
import { runPinSpaceConnection } from "../migration/0045-pin-space-connection.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../apps/api/test/helpers/auth.ts";
import {
  seedAgent,
  seedPackage,
  seedRun,
  seedSchedule,
  seedSpace,
  seedSpacePackage,
} from "../../apps/api/test/helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../apps/api/test/helpers/integration-manifests.ts";
import { activatePackage } from "../../apps/api/src/services/space-packages.ts";
import { resolveConnectionsForRun } from "../../apps/api/src/services/integration-connection-resolver.ts";

const INTEGRATION = "@mig0045/svc";
const AGENT = "@mig0045/agent";

const integrationManifest = localIntegrationManifest({
  name: INTEGRATION,
  serverName: "@mig0045/svc-server",
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
  display_name: "Pinned agent",
  dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
  integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
};

let ctx: TestContext;
/** The space under test, and another one of the same organization. */
let here: string;
let elsewhere: string;
const lines: string[] = [];
const run = (apply: boolean) => runPinSpaceConnection({ apply, out: (line) => lines.push(line) });

/** An org-scoped connection made in `madeIn`; `scoped`: a space client's, serving `madeIn` only. */
async function seedConnection(
  madeIn: string,
  opts: { scoped?: boolean; userId?: string; orgId?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: opts.orgId ?? ctx.orgId,
      spaceId: opts.scoped ? madeIn : null,
      originSpaceId: opts.scoped ? null : madeIn,
      userId: opts.userId ?? ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

/** A run that bound `connectionId`; `opts` aside: the member's, of AGENT, in `here`, by default. */
async function seedBoundRun(
  connectionId: string,
  opts: {
    source?: ConnectionResolutionSource;
    agentId?: string;
    userId?: string;
    spaceId?: string;
    orgId?: string;
  } = {},
): Promise<void> {
  await seedRun({
    packageId: opts.agentId ?? AGENT,
    orgId: opts.orgId ?? ctx.orgId,
    spaceId: opts.spaceId ?? here,
    userId: opts.userId ?? ctx.user.id,
    resolvedConnections: {
      [INTEGRATION]: [
        {
          connectionId,
          source: opts.source ?? "fallback_auto",
          label: "Connexion",
          accountId: "acct",
        },
      ],
    },
  });
}

async function seedPin(userId: string | null, connectionId: string): Promise<void> {
  await db.insert(integrationPins).values({
    spaceId: here,
    packageId: AGENT,
    integrationId: INTEGRATION,
    userId,
    connectionIds: [connectionId],
  });
}

async function pinRows() {
  return db
    .select({
      spaceId: integrationPins.spaceId,
      packageId: integrationPins.packageId,
      integrationId: integrationPins.integrationId,
      userId: integrationPins.userId,
      connectionIds: integrationPins.connectionIds,
    })
    .from(integrationPins)
    .orderBy(integrationPins.spaceId, integrationPins.packageId);
}

async function pinAudits() {
  return db
    .select({
      orgId: auditEvents.orgId,
      spaceId: auditEvents.spaceId,
      actorType: auditEvents.actorType,
      resourceId: auditEvents.resourceId,
      after: auditEvents.after,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, "integration.member_pin.upserted"));
}

describe("0045 — the connection made in a space pinned for the agents run there by default", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0045" });
    here = ctx.defaultSpaceId;
    elsewhere = (await seedSpace({ orgId: ctx.orgId })).id;
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      draftManifest: integrationManifest,
    });
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest,
    });
  });

  it("pins it on --apply only, once, and lists the schedules binding through the pin", async () => {
    const made = await seedConnection(here);
    await seedConnection(elsewhere);
    await seedBoundRun(made);
    const schedule = { packageId: AGENT, orgId: ctx.orgId, spaceId: here, userId: ctx.user.id };
    const unnamed = await seedSchedule(schedule);
    await seedSchedule({ ...schedule, connectionOverrides: { [INTEGRATION]: [made] } });
    await seedSchedule({ ...schedule, enabled: false });
    const planned = {
      pins: [
        {
          spaceId: here,
          userId: ctx.user.id,
          agentId: AGENT,
          integrationId: INTEGRATION,
          connectionId: made,
        },
      ],
      schedules: [{ scheduleId: unnamed.id, agentId: AGENT, integrationId: INTEGRATION }],
    };

    expect(await run(false)).toEqual(planned);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("to pin: 1");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(await pinRows()).toEqual([]);
    expect(await pinAudits()).toEqual([]);

    lines.length = 0;
    expect(await run(true)).toEqual(planned);
    expect(lines).toContain(`org ${ctx.orgId}: pinned 1, schedules on a pin 1`);
    expect(lines).toContain(
      `  pin ${AGENT} / ${INTEGRATION} → ${made} (space ${here}, member ${ctx.user.id})`,
    );
    expect(lines).toContain(`  schedule ${unnamed.id}: ${AGENT} / ${INTEGRATION}`);
    expect(lines.at(-1)).toBe("0045: APPLIED — committed.");
    expect(await pinRows()).toEqual([
      {
        spaceId: here,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: ctx.user.id,
        connectionIds: [made],
      },
    ]);
    expect(await pinAudits()).toEqual([
      {
        orgId: ctx.orgId,
        spaceId: here,
        actorType: "system",
        resourceId: `${INTEGRATION}#${AGENT}`,
        after: { connectionIds: [made], userId: ctx.user.id, reason: "migrated" },
      },
    ]);

    lines.length = 0;
    expect(await run(true)).toEqual({ pins: [], schedules: [] });
    expect(lines).toContain("to pin: 0");
    expect(lines).toContain("left to pin: 0");
    expect(await pinRows()).toHaveLength(1);
    expect(await pinAudits()).toHaveLength(1);
  });

  it("the pin is what the member's next run of the agent binds there", async () => {
    const scope = { orgId: ctx.orgId, spaceId: here };
    await activatePackage(scope, AGENT);
    await activatePackage(scope, INTEGRATION);
    const made = await seedConnection(here);
    await seedConnection(elsewhere);
    await seedBoundRun(made);

    await run(true);
    const { resolved, errors } = await resolveConnectionsForRun({
      agentManifest,
      packageId: AGENT,
      actor: { type: "user", id: ctx.user.id },
      scope,
    });
    expect(errors).toEqual([]);
    expect(resolved[INTEGRATION]).toMatchObject([{ connectionId: made, source: "member_pin" }]);
  });

  describe("writes no pin when", () => {
    async function expectNoPin(): Promise<void> {
      expect(await run(true)).toEqual({ pins: [], schedules: [] });
      expect(lines).toContain("to pin: 0");
    }

    it("the member owns one connection usable there", async () => {
      await seedBoundRun(await seedConnection(here));
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("two of their connections were made there", async () => {
      await seedBoundRun(await seedConnection(here));
      await seedConnection(here);
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("their other connection is scoped to another space, which it does not leave", async () => {
      await seedBoundRun(await seedConnection(here));
      await seedConnection(elsewhere, { scoped: true });
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("the space blocks the members' own connections made elsewhere", async () => {
      await seedSpacePackage(here, INTEGRATION, { blockUserConnections: true });
      await seedBoundRun(await seedConnection(here));
      await seedConnection(elsewhere);
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("no run of theirs bound it by default", async () => {
      const made = await seedConnection(here);
      await seedConnection(elsewhere);
      await seedBoundRun(made, { source: "member_pin" });
      await seedBoundRun(made, { source: "run_override" });
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("the run that bound it by default was a colleague's", async () => {
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id, "member");
      const made = await seedConnection(here);
      await seedConnection(elsewhere);
      await seedBoundRun(made, { userId: colleague.id });
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("their runs bound the connection made elsewhere by default", async () => {
      await seedConnection(here);
      await seedBoundRun(await seedConnection(elsewhere));
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("the agent is an inline run's shadow package", async () => {
      const shadow = "@mig0045/shadow";
      await seedPackage({ id: shadow, orgId: ctx.orgId, ephemeral: true });
      await seedBoundRun(await seedConnection(here), { agentId: shadow });
      await seedConnection(elsewhere);
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });

    it("the member already pinned the agent, whose pin is left as it is", async () => {
      await seedBoundRun(await seedConnection(here));
      const chosen = await seedConnection(elsewhere);
      await seedPin(ctx.user.id, chosen);
      await expectNoPin();
      expect(await pinRows()).toMatchObject([{ userId: ctx.user.id, connectionIds: [chosen] }]);
    });

    it("an admin pin governs the agent", async () => {
      const made = await seedConnection(here);
      await seedConnection(elsewhere);
      await seedBoundRun(made);
      await seedPin(null, made);
      await expectNoPin();
      expect(await pinRows()).toMatchObject([{ userId: null }]);
    });

    it("a space default names a set for the integration, which a member pin would outrank", async () => {
      const made = await seedConnection(here);
      const other = await seedConnection(elsewhere);
      await seedBoundRun(made);
      await db.insert(integrationOrgDefaults).values({
        spaceId: here,
        integrationId: INTEGRATION,
        connectionIds: [other],
        enforce: false,
      });
      await expectNoPin();
      expect(await pinRows()).toEqual([]);
    });
  });

  it("pins each organization in a transaction of its own, each rolled back on a dry run", async () => {
    const otherCtx = await createTestContext({ orgSlug: "mig0045-other" });
    const theirAgent = "@mig0045-other/agent";
    await seedAgent({ id: theirAgent, orgId: otherCtx.orgId });
    const theirs = { orgId: otherCtx.orgId, userId: otherCtx.user.id };
    const ourConnection = await seedConnection(here);
    await seedConnection(elsewhere);
    await seedBoundRun(ourConnection);
    const theirConnection = await seedConnection(otherCtx.defaultSpaceId, theirs);
    await seedConnection((await seedSpace({ orgId: otherCtx.orgId })).id, theirs);
    await seedBoundRun(theirConnection, {
      ...theirs,
      agentId: theirAgent,
      spaceId: otherCtx.defaultSpaceId,
    });

    await run(false);
    expect(lines).toContain("to pin: 2");
    for (const orgId of [ctx.orgId, otherCtx.orgId]) {
      expect(lines).toContain(`org ${orgId}: pinned 1, schedules on a pin 0`);
    }
    expect(await pinRows()).toEqual([]);

    lines.length = 0;
    const { pins } = await run(true);
    expect(pins.map((pin) => pin.connectionId).sort()).toEqual(
      [ourConnection, theirConnection].sort(),
    );
    expect(lines).toContain("left to pin: 0");
    expect(await pinRows()).toHaveLength(2);
  });
});
