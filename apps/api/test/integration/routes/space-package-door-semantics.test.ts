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
import { zipSync } from "fflate";
import { auditEvents, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPackageShare,
  seedPublishedVersion,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import {
  apiIntegrationManifest,
  httpHeaderDelivery,
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
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
  // Placed here and never switched on: a row saying `false`.
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

describe("a placement that is already off stays off on a DELETE", () => {
  it("answers 204, keeps the row and audits nothing", async () => {
    const res = await deactivate(OFFERED);
    expect(res.status, await res.clone().text()).toBe(204);
    expect((await placementRow(OFFERED))?.enabled).toBe(false);
    expect(await auditCount("package.deactivated", OFFERED)).toHaveLength(0);

    // Control: switched on, THEN off, is a real deactivation.
    expect((await activate(OFFERED)).status).toBe(201);
    expect((await deactivate(OFFERED)).status).toBe(204);
    expect((await placementRow(OFFERED))?.enabled).toBe(false);
    expect(await auditCount("package.deactivated", OFFERED)).toHaveLength(1);
  });
});

describe("CONFIGURING never activates — the row is the activation's, not the setting's", () => {
  // `requireAgent()` asks PLACEMENT, so a placement switched off reaches the
  // agent configure routes. Those write through `updateSpacePackage`, which
  // updates the row's settings and never its `enabled`: a model picker is not
  // an activation door.
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

  it("configures a placement switched off without switching it on", async () => {
    const res = await setModel();
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await placementRow(OFFERED_AGENT))?.enabled).toBe(false);
    expect(await auditCount("package.activated", OFFERED_AGENT)).toHaveLength(0);
  });

  it("CONTROL: once switched on, the same call configures it — and switching it off does not undo that", async () => {
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

  it("ranks no provenance first: newest first, a system package among the others", async () => {
    const newer = "@doors/newer-skill";
    await seedPackage({
      id: newer,
      orgId: ctx.orgId,
      type: "skill",
      homeSpaceId: ctx.defaultSpaceId,
      createdAt: new Date(Date.now() + 60_000),
      draftManifest: { name: newer, version: "1.0.0", type: "skill" },
    });
    await seedSpacePackage(ctx.defaultSpaceId, newer);
    expect(await listSkillIndex()).toEqual([newer, SYSTEM_SKILL]);
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

describe("activating an agent names its integrations left off, and activates none", () => {
  // The door activates one package (activating an integration opens its
  // credentials to the space), so what the agent is now on WITHOUT is told in
  // `warnings[]`, in the launch warnings' vocabulary.
  const AGENT = "@doors/agent";
  const REQUIRED_OFF = "@doors/required-off";
  const OPTIONAL_OFF = "@doors/optional-off";
  const ON = "@doors/on";

  const integration = (id: string) =>
    localIntegrationManifest({
      name: id,
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/**"],
          credentialFields: ["api_key"],
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
      tools_policy: { search: {} },
    });

  const agentDeclaring = (integrations: Record<string, boolean>) => ({
    name: AGENT,
    version: "0.1.0",
    type: "agent",
    schema_version: "0.2",
    dependencies: {
      integrations: Object.fromEntries(Object.keys(integrations).map((id) => [id, "^1.0.0"])),
    },
    integrations_configuration: Object.fromEntries(
      Object.entries(integrations).map(([id, required]) => [id, { tools: ["search"], required }]),
    ),
  });

  type Body = { warnings: { field: string; code: string; title: string; required: boolean }[] };

  beforeEach(async () => {
    for (const id of [REQUIRED_OFF, OPTIONAL_OFF, ON]) {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "integration",
        homeSpaceId: ctx.defaultSpaceId,
        draftManifest: integration(id),
      });
    }
    expect((await activate(ON)).status).toBe(201);
  });

  it("names each inactive one with its `required` flag, and leaves them off", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: agentDeclaring({ [REQUIRED_OFF]: true, [OPTIONAL_OFF]: false, [ON]: true }),
    });
    const res = await activate(AGENT);
    expect(res.status, await res.clone().text()).toBe(201);
    const { warnings } = (await res.json()) as Body;
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: `integrations.${REQUIRED_OFF}`,
          code: "integration_not_active",
          title: "Integration Not Active",
          required: true,
        }),
        expect.objectContaining({
          field: `integrations.${OPTIONAL_OFF}`,
          code: "integration_not_active",
          required: false,
        }),
      ]),
    );
    // Nothing was activated in its place, and a repeat says the same.
    expect(await placementRow(REQUIRED_OFF)).toBeNull();
    expect(await placementRow(OPTIONAL_OFF)).toBeNull();
    const repeat = await activate(AGENT);
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as Body).warnings).toHaveLength(2);
  });

  it("judges the version a selector-less launch runs, not the draft", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: agentDeclaring({ [ON]: true }),
    });
    await seedPublishedVersion(AGENT, "0.1.0", {
      manifest: agentDeclaring({ [REQUIRED_OFF]: true }),
    });
    const res = await activate(AGENT);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as Body).warnings).toEqual([
      expect.objectContaining({ field: `integrations.${REQUIRED_OFF}`, required: true }),
    ]);
  });

  it("answers `[]` when every declared integration is active", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: agentDeclaring({ [ON]: true }),
    });
    const res = await activate(AGENT);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as Body).warnings).toEqual([]);
  });

  it("says nothing of an inert optional integration, which the launch never mentions", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        ...agentDeclaring({}),
        dependencies: { integrations: { [OPTIONAL_OFF]: "^1.0.0" } },
        integrations_configuration: { [OPTIONAL_OFF]: { required: false } },
      },
    });
    const res = await activate(AGENT);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as Body).warnings).toEqual([]);
  });

  it("uses each agent's published integration pin to decide whether an optional dependency is inert", async () => {
    const service = "@doors/search";
    const draft = remoteIntegrationManifest({ name: service, tools_policy: { search: {} } });
    await seedPackage({ id: service, orgId: ctx.orgId, type: "integration", draftManifest: draft });
    await seedPublishedVersion(service, "1.0.0", {
      manifest: { ...draft, default_tools: ["search"] },
    });
    await seedPublishedVersion(service, "2.0.0", { manifest: { ...draft, version: "2.0.0" } });
    for (const [agent, pin, expected] of [
      [
        AGENT,
        "^1.0.0",
        [expect.objectContaining({ field: `integrations.${service}`, required: false })],
      ],
      ["@doors/quiet", "latest", []],
    ] as const) {
      await seedPackage({
        id: agent,
        orgId: ctx.orgId,
        type: "agent",
        homeSpaceId: ctx.defaultSpaceId,
        draftManifest: {
          ...agentDeclaring({}),
          name: agent,
          dependencies: { integrations: { [service]: pin } },
        },
      });
      const res = await activate(agent);
      expect(res.status, await res.clone().text()).toBe(201);
      expect(((await res.json()) as Body).warnings).toEqual([...expected]);
    }
  });

  it("tells the import doors the same, after the agent's own warnings", async () => {
    // A remote integration, published: the bundle graph resolves it from its stored archive.
    const REMOTE_OFF = "@doors/remote-off";
    const remote = apiIntegrationManifest({
      name: REMOTE_OFF,
      auths: { primary: { type: "api_key", authorizedUris: ["https://api.example.com/**"] } },
      tools_policy: { search: {} },
    }) as unknown as Record<string, unknown>;
    await seedPackage({
      id: REMOTE_OFF,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: remote,
    });
    await seedPublishedVersion(REMOTE_OFF, "1.0.0", { manifest: remote });
    const id = `@${ctx.org.slug}/imported`;
    const enc = (text: string) => new TextEncoder().encode(text);
    const manifest = {
      ...agentDeclaring({ [REMOTE_OFF]: true }),
      name: id,
      display_name: "Imported",
    };
    const afps = zipSync({
      "manifest.json": enc(JSON.stringify(manifest)),
      "prompt.md": enc("You are an agent."),
    });
    const expected = `Integration '${REMOTE_OFF}' is not active in this space — activate it with POST /api/spaces/${ctx.defaultSpaceId}/packages {"packageId":"${REMOTE_OFF}"}; a launch of this agent here is refused until then.`;
    for (const [path, prefix] of [
      ["/api/packages/import", ""],
      ["/api/packages/import-bundle?force=true", `${id}@0.1.0: `],
    ] as const) {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(afps)], "imported.afps"));
      const res = await app.request(path, {
        method: "POST",
        headers: authHeaders(ctx),
        body: form,
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const { warnings } = (await res.json()) as { warnings?: string[] };
      expect(warnings, path).toContain(`${prefix}${expected}`);
    }
    expect(await placementRow(REMOTE_OFF)).toBeNull();
  });

  it("answers `[]` on an integration's own activation", async () => {
    const res = await activate(REQUIRED_OFF);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as Body).warnings).toEqual([]);
  });
});
