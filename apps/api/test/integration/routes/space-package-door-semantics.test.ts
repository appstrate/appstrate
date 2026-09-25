// SPDX-License-Identifier: Apache-2.0

/**
 * What the two activation doors ANSWER, and what they write to the audit log.
 *
 * The rule they both read is "the row always wins, the deployment's default
 * decides where there is no row" (`services/package-activation.ts`), and the
 * doors are its two write halves. Three things follow, and this suite pins
 * each of them:
 *
 *   - the STATUS reports what the CALL did, not what row it touched: `201`
 *     when the package was off and is now on, `200` otherwise — including for a
 *     package the deployment already switches on without any row;
 *   - a SYSTEM package is switchable like any other. The placement row outranks
 *     the default, so `DELETE` on one is a real refusal and not a 204 that
 *     changes nothing;
 *   - the two AUDIT entries are symmetric: written when the state moved, and
 *     never for a repeat. A log full of no-op toggles is a log nobody can read
 *     a real one out of.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare, seedSpace } from "../../helpers/seed.ts";
import { isPackageActiveHere } from "../../../src/services/space-packages.ts";

const app = getTestApp();

const SYSTEM_SKILL = "@appstrate/system-skill";
const OFFERED = "@doors/offered";

let ctx: TestContext;
let otherSpaceId: string;

const activate = (packageId: string, spaceId = ctx.defaultSpaceId) =>
  app.request(`/api/spaces/${spaceId}/packages`, {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ packageId }),
  });

const deactivate = (packageId: string, spaceId = ctx.defaultSpaceId) =>
  app.request(`/api/spaces/${spaceId}/packages/${packageId}`, {
    method: "DELETE",
    headers: authHeaders(ctx),
  });

const auditCount = (action: string, packageId: string) =>
  db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, packageId)));

const placementRow = async (packageId: string, spaceId = ctx.defaultSpaceId) => {
  const [row] = await db
    .select()
    .from(spacePackages)
    .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, spaceId)));
  return row ?? null;
};

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  otherSpaceId = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
  await seedPackage({
    id: SYSTEM_SKILL,
    orgId: null,
    source: "system",
    type: "skill",
    homeSpaceId: null,
    draftManifest: { name: SYSTEM_SKILL, version: "1.0.0", type: "skill" },
  });
  // Offered here, never taken up: the "pending offer" state, which is a
  // placement with no row.
  await seedPackage({ id: OFFERED, orgId: ctx.orgId, homeSpaceId: otherSpaceId });
  await seedPackageShare(ctx.defaultSpaceId, OFFERED);
});

describe("a system package is switchable, and the row outranks the default", () => {
  it("answers 200 to the first activation — it was already on", async () => {
    const first = await activate(SYSTEM_SKILL);
    expect(first.status, await first.clone().text()).toBe(200);
    // A row IS written (that is how the space can later say `false`), but it
    // states a decision that changes nothing, so nothing is audited.
    expect((await placementRow(SYSTEM_SKILL))?.enabled).toBe(true);
    expect(await auditCount("package.activated", SYSTEM_SKILL)).toHaveLength(0);
  });

  it("switches OFF for real, and the run gate obeys", async () => {
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, SYSTEM_SKILL),
    ).toBe(true);
    expect((await deactivate(SYSTEM_SKILL)).status).toBe(204);
    expect((await placementRow(SYSTEM_SKILL))?.enabled).toBe(false);
    // The point of the change: before it, this answered 204 and the package
    // kept running everywhere — a switch that changed nothing, and an audit
    // entry for an act that never happened.
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, SYSTEM_SKILL),
    ).toBe(false);
    expect(await auditCount("package.deactivated", SYSTEM_SKILL)).toHaveLength(1);

    // …and only HERE. The other space never answered, so it keeps the default.
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: otherSpaceId }, SYSTEM_SKILL),
    ).toBe(true);
  });

  it("comes back on with 201 — this call is what turned it on", async () => {
    expect((await deactivate(SYSTEM_SKILL)).status).toBe(204);
    const back = await activate(SYSTEM_SKILL);
    expect(back.status, await back.clone().text()).toBe(201);
    expect(await auditCount("package.activated", SYSTEM_SKILL)).toHaveLength(1);
  });
});

describe("a pending offer survives a DELETE — there is nothing to switch off", () => {
  it("answers 404 and leaves the offer with no row at all", async () => {
    // Writing `enabled: false` here would turn "nobody has taken this up" into
    // "somebody switched this off" — a decision the recipient never made, and
    // the one state the library renders as a pending offer.
    const res = await deactivate(OFFERED);
    expect(res.status, await res.clone().text()).toBe(404);
    expect(await placementRow(OFFERED)).toBeNull();
    expect(await auditCount("package.deactivated", OFFERED)).toHaveLength(0);

    // Control: taking it up works, and THEN it can be switched off.
    expect((await activate(OFFERED)).status).toBe(201);
    expect((await deactivate(OFFERED)).status).toBe(204);
    expect((await placementRow(OFFERED))?.enabled).toBe(false);
  });
});

describe("CONFIGURING never activates — the row is the activation's, not the setting's", () => {
  // `requireAgent()` asks PLACEMENT, so a pending offer now reaches the agent
  // configure routes. Those write through `updateSpacePackage`, whose default
  // mode upserts — and a `space_packages` row means ACTIVE. Left ungated, a
  // model picker would be a second activation door: no placement rule, no
  // `<type>:share`, no `package.activated`.
  const OFFERED_AGENT = "@doors/offered-agent";

  beforeEach(async () => {
    await seedPackage({
      id: OFFERED_AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: otherSpaceId,
      draftManifest: { name: OFFERED_AGENT, version: "1.0.0", type: "agent" },
    });
    await seedPackageShare(ctx.defaultSpaceId, OFFERED_AGENT);
  });

  const setModel = () =>
    app.request(`/api/agents/${OFFERED_AGENT}/model`, {
      method: "PATCH",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ modelId: null }),
    });

  it("refuses to write a placement row for an offer nobody has taken up", async () => {
    const res = await setModel();
    expect(res.status, await res.clone().text()).toBe(404);
    expect(((await res.json()) as { detail?: string }).detail).toContain(
      "not active in this space",
    );
    expect(await placementRow(OFFERED_AGENT)).toBeNull();
    expect(await auditCount("package.activated", OFFERED_AGENT)).toHaveLength(0);
  });

  it("CONTROL: once the offer is taken up, the same call configures it — and switching it off does not undo that", async () => {
    expect((await activate(OFFERED_AGENT)).status).toBe(201);
    expect((await setModel()).status).toBe(200);

    // And on a package that is placed and SWITCHED OFF, configuring answers the
    // same 200: the row is there, the verdict does not move.
    expect((await deactivate(OFFERED_AGENT)).status).toBe(204);
    expect((await setModel()).status).toBe(200);
    expect((await placementRow(OFFERED_AGENT))?.enabled).toBe(false);
  });

  it("still materializes the row for a package the deployment switches on", async () => {
    // The case the upsert exists for: a system package has no row until its
    // first per-space setting, and the row it gains says what it already was.
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ packageId: SYSTEM_SKILL }),
    });
    expect(res.status).toBe(200);
    expect((await placementRow(SYSTEM_SKILL))?.enabled).toBe(true);
    expect(await auditCount("package.activated", SYSTEM_SKILL)).toHaveLength(0);
  });
});

describe("the type index reads the same rule as the run gate", () => {
  const listSkillIndex = async () => {
    const res = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data.map((row) => row.id);
  };

  it("lists a system package that has no row, and drops it once the space switches it off", async () => {
    // The index page and the agent editor's picker are the same listing, and it
    // reads THE activation rule — `activeHereSql`, the one the run gate reads.
    // A filter of its own here (a row, enabled, no default branch) offers
    // neither the system skills the space runs nor the system integrations
    // readiness accepts, and then a per-type correction pass has to patch that
    // up route by route. One rule, no correction.
    expect(await listSkillIndex()).toContain(SYSTEM_SKILL);
    expect((await deactivate(SYSTEM_SKILL)).status).toBe(204);
    expect(await listSkillIndex()).not.toContain(SYSTEM_SKILL);
    expect((await activate(SYSTEM_SKILL)).status).toBe(201);
    expect(await listSkillIndex()).toContain(SYSTEM_SKILL);
  });
});

describe("the two audit entries are symmetric", () => {
  it("writes neither for a repeat of a state the space is already in", async () => {
    expect((await activate(OFFERED)).status).toBe(201);
    expect((await activate(OFFERED)).status).toBe(200);
    expect((await activate(OFFERED)).status).toBe(200);
    expect(await auditCount("package.activated", OFFERED)).toHaveLength(1);

    expect((await deactivate(OFFERED)).status).toBe(204);
    expect((await deactivate(OFFERED)).status).toBe(204);
    expect((await deactivate(OFFERED)).status).toBe(204);
    expect(await auditCount("package.deactivated", OFFERED)).toHaveLength(1);

    // Six calls, two entries: the trail reads as the two acts that happened.
    await assertDbCount(auditEvents, eq(auditEvents.resourceId, OFFERED), 2);
  });
});
