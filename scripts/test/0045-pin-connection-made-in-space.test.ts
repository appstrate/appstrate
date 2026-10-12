// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0045` against the test database. The main fixture: a member owning a connection made
 * in a space and another made elsewhere, both usable there, whose last run of an agent there bound
 * the first by default after the second existed. It gets a member pin; a dry run writes nothing, a
 * second `--apply` neither. Every other case is that fixture with one condition changed. Enabled
 * schedules naming no set where their member owns several usable connections are listed with what
 * their next fire binds through.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  auditEvents,
  integrationConnections,
  integrationConnectionShares,
  integrationOrgDefaults,
  integrationPins,
  organizationMembers,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { ConnectionResolutionSource } from "@appstrate/core/integration";
import { runPinConnectionMadeInSpace } from "../migration/0045-pin-connection-made-in-space.ts";
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
/** Minutes since the first run: each seeded run starts one after the previous. */
let minute: number;
const lines: string[] = [];
const run = (apply: boolean) =>
  runPinConnectionMadeInSpace({ apply, out: (line) => lines.push(line) });

/** An org-scoped connection made in `madeIn`; `scoped`: a space client's, serving `madeIn` only. */
async function seedConnection(
  madeIn: string,
  opts: { scoped?: boolean; userId?: string; orgId?: string; createdAt?: Date } = {},
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
      createdAt: opts.createdAt ?? new Date("2026-01-01T00:00:00Z"),
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
    scheduleId?: string;
  } = {},
): Promise<void> {
  const source = opts.source ?? "fallback_auto";
  await seedRun({
    packageId: opts.agentId ?? AGENT,
    orgId: opts.orgId ?? ctx.orgId,
    spaceId: opts.spaceId ?? here,
    userId: opts.userId ?? ctx.user.id,
    scheduleId: opts.scheduleId,
    startedAt: new Date(Date.UTC(2026, 1, 1, 0, minute++)),
    resolvedConnections: {
      [INTEGRATION]: [{ connectionId, source, label: "Connexion", accountId: "acct" }],
    },
  });
}

/** The main fixture, its run aside: one connection made `here`, one made `elsewhere`. */
async function seedBothSpaces(): Promise<{ made: string; other: string }> {
  return { made: await seedConnection(here), other: await seedConnection(elsewhere) };
}

/** An enabled schedule of the member on AGENT in `here`, naming no set. */
const seedMemberSchedule = (overrides: Partial<Parameters<typeof seedSchedule>[0]> = {}) =>
  seedSchedule({
    packageId: AGENT,
    orgId: ctx.orgId,
    spaceId: here,
    userId: ctx.user.id,
    ...overrides,
  });

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
  const { spaceId, packageId, integrationId, userId, connectionIds } = integrationPins;
  return db
    .select({ spaceId, packageId, integrationId, userId, connectionIds })
    .from(integrationPins)
    .orderBy(spaceId);
}

async function pinAudits() {
  const { orgId, spaceId, actorType, resourceId, after } = auditEvents;
  return db
    .select({ orgId, spaceId, actorType, resourceId, after })
    .from(auditEvents)
    .where(eq(auditEvents.action, "integration.member_pin.upserted"));
}

describe("0045 — the connection made in a space pinned for the agents binding it by default", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    minute = 0;
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

  it("pins it on --apply only, once, a schedule's fire counting as a run of the member", async () => {
    const { made } = await seedBothSpaces();
    const unnamed = await seedMemberSchedule();
    await seedMemberSchedule({ connectionOverrides: { [INTEGRATION]: [made] } });
    await seedMemberSchedule({ enabled: false });
    await seedBoundRun(made, { scheduleId: unnamed.id });
    const on = { spaceId: here, userId: ctx.user.id, agentId: AGENT, integrationId: INTEGRATION };
    const planned: Awaited<ReturnType<typeof run>> = {
      pins: [{ ...on, connectionId: made }],
      schedules: [{ scheduleId: unnamed.id, ...on, verdict: "binds through the pin" }],
    };

    expect(await run(false)).toEqual(planned);
    expect(lines[0]).toStartWith("database: ");
    expect(lines[1]).toBe("user-owned org-scoped connections: 2");
    expect(lines).toContain("to pin: 1");
    expect(lines).toContain("schedules with no pin: 0");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(await pinRows()).toEqual([]);
    expect(await pinAudits()).toEqual([]);

    lines.length = 0;
    expect(await run(true)).toEqual(planned);
    expect(lines).toContain(`org ${ctx.orgId}: pinned 1, schedules naming no set 1`);
    expect(lines).toContain(
      `  pin ${AGENT} / ${INTEGRATION} → ${made} (space ${here}, member ${ctx.user.id})`,
    );
    expect(lines).toContain(
      `  schedule ${unnamed.id}: ${AGENT} / ${INTEGRATION} (space ${here}, member ${ctx.user.id}) — binds through the pin`,
    );
    expect(lines.at(-1)).toBe("0045: APPLIED — committed.");
    const pin = { spaceId: here, packageId: AGENT, integrationId: INTEGRATION };
    expect(await pinRows()).toEqual([{ ...pin, userId: ctx.user.id, connectionIds: [made] }]);
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
    expect(await run(true)).toEqual({ pins: [], schedules: planned.schedules });
    expect(lines).toContain("to pin: 0");
    expect(lines).toContain("left to pin: 0");
    expect(await pinRows()).toHaveLength(1);
    expect(await pinAudits()).toHaveLength(1);
  });

  it("the pin is what the member's next run of the agent binds there", async () => {
    const scope = { orgId: ctx.orgId, spaceId: here };
    await activatePackage(scope, AGENT);
    await activatePackage(scope, INTEGRATION);
    const { made } = await seedBothSpaces();
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

  it("lists the member's schedules with no pin, in a space they connected from or not, and writes nothing", async () => {
    await seedBothSpaces();
    const third = (await seedSpace({ orgId: ctx.orgId })).id;
    const firing = [await seedMemberSchedule(), await seedMemberSchedule({ spaceId: third })];
    const on = `${AGENT} / ${INTEGRATION}`;
    const undeclaring = "@mig0045/undeclaring";
    await seedAgent({ id: undeclaring, orgId: ctx.orgId });
    await seedMemberSchedule({ packageId: undeclaring });

    const { pins, schedules } = await run(true);
    expect(pins).toEqual([]);
    expect(schedules).toHaveLength(2);
    expect(lines).toContain("schedules with no pin: 2");
    for (const { id, spaceId } of firing) {
      expect(lines).toContain(
        `  schedule ${id}: ${on} (space ${spaceId}, member ${ctx.user.id}) — no pin: name the set`,
      );
    }
    expect(await pinRows()).toEqual([]);
  });

  describe("writes no pin and lists no schedule when", () => {
    /** `--apply` over the fixture and an enabled schedule of the member naming no set. */
    async function expectNothing(): Promise<void> {
      await seedMemberSchedule();
      const before = await pinRows();
      expect(await run(true)).toEqual({ pins: [], schedules: [] });
      expect(lines).toContain("to pin: 0");
      expect(await pinRows()).toEqual(before);
      expect(await pinAudits()).toEqual([]);
    }

    it("the member owns one connection usable there", async () => {
      await seedBoundRun(await seedConnection(here));
      await expectNothing();
    });

    it("their other connection is scoped to another space, which it does not leave", async () => {
      await seedBoundRun(await seedConnection(here));
      await seedConnection(elsewhere, { scoped: true });
      await expectNothing();
    });

    it("the space blocks the members' own connections made elsewhere", async () => {
      await seedSpacePackage(here, INTEGRATION, { blockUserConnections: true });
      await seedBoundRun((await seedBothSpaces()).made);
      await expectNothing();
    });

    it("the member has left the organization", async () => {
      await seedBoundRun((await seedBothSpaces()).made);
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, ctx.user.id));
      await expectNothing();
    });

    it("an org default names a set for the integration there", async () => {
      const { made, other } = await seedBothSpaces();
      await seedBoundRun(made);
      await db.insert(integrationOrgDefaults).values({
        spaceId: here,
        integrationId: INTEGRATION,
        connectionIds: [other],
        enforce: false,
      });
      await expectNothing();
    });

    it("an admin pin governs the agent", async () => {
      const { made } = await seedBothSpaces();
      await seedBoundRun(made);
      await seedPin(null, made);
      await expectNothing();
    });
  });

  describe("writes no pin, the member's schedule on the agent listed as having none, when", () => {
    async function expectNoPin(): Promise<void> {
      const schedule = await seedMemberSchedule();
      const { pins, schedules } = await run(true);
      expect(pins).toEqual([]);
      expect(schedules.map((row) => [row.scheduleId, row.verdict])).toEqual([
        [schedule.id, "no pin: name the set"],
      ]);
      expect(await pinRows()).toEqual([]);
    }

    it("two of their connections were made there", async () => {
      await seedBoundRun(await seedConnection(here));
      await seedConnection(here);
      await seedConnection(elsewhere);
      await expectNoPin();
    });

    it("their other connection is shared into the space, which it reached whatever its scope", async () => {
      const { made, other } = await seedBothSpaces();
      await seedBoundRun(made);
      await db
        .insert(integrationConnectionShares)
        .values({ connectionId: other, spaceId: here, orgId: ctx.orgId });
      await expectNoPin();
    });

    it("their last binding there was a launch override, after an older default one", async () => {
      const { made } = await seedBothSpaces();
      await seedBoundRun(made);
      await seedBoundRun(made, { source: "run_override" });
      await expectNoPin();
    });

    it("the default binding predates their other connection", async () => {
      const made = await seedConnection(here);
      await seedBoundRun(made);
      await seedConnection(elsewhere, { createdAt: new Date("2026-03-01T00:00:00Z") });
      await expectNoPin();
    });

    it("the run that bound it by default was a colleague's", async () => {
      const colleague = await createTestUser();
      await addOrgMember(ctx.orgId, colleague.id, "member");
      await seedBoundRun((await seedBothSpaces()).made, { userId: colleague.id });
      await expectNoPin();
    });

    it("their runs bound the connection made elsewhere by default", async () => {
      await seedBoundRun((await seedBothSpaces()).other);
      await expectNoPin();
    });

    it("the run was an inline run's, of a shadow package", async () => {
      const shadow = "@mig0045/shadow";
      await seedPackage({ id: shadow, orgId: ctx.orgId, ephemeral: true });
      await seedBoundRun((await seedBothSpaces()).made, { agentId: shadow });
      await expectNoPin();
    });
  });

  it("leaves a pin the member set as it is, their schedule binding through it", async () => {
    const { made, other } = await seedBothSpaces();
    await seedBoundRun(made);
    await seedPin(ctx.user.id, other);
    const schedule = await seedMemberSchedule();

    const { pins, schedules } = await run(true);
    expect(pins).toEqual([]);
    expect(schedules).toMatchObject([
      { scheduleId: schedule.id, verdict: "binds through the pin" },
    ]);
    expect(await pinRows()).toMatchObject([{ userId: ctx.user.id, connectionIds: [other] }]);
  });

  it("pins each organization in a transaction of its own, each rolled back on a dry run", async () => {
    const otherCtx = await createTestContext({ orgSlug: "mig0045-other" });
    const theirAgent = "@mig0045-other/agent";
    await seedAgent({ id: theirAgent, orgId: otherCtx.orgId });
    const theirs = { orgId: otherCtx.orgId, userId: otherCtx.user.id };
    const ourConnection = (await seedBothSpaces()).made;
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
      expect(lines).toContain(`org ${orgId}: pinned 1, schedules naming no set 0`);
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
