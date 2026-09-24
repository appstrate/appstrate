// SPDX-License-Identifier: Apache-2.0

/**
 * An ORPHAN placement row — `space_packages` with neither a home nor a share
 * behind it — is nothing, on every surface.
 *
 * `scripts/migration/0016` repairs the rows inherited from the model where a
 * row WAS the placement, and no live path writes another
 * (`reconcilePlacementsAfterRehome` covers both re-homes). This suite holds
 * the other half of that contract: the platform must not honour one if it
 * finds one, because a row is a decision a space made about a package it may
 * since have lost — and the package it names may be somebody's PRIVATE draft,
 * homed in a personal space nobody else reads.
 *
 * The three surfaces below are the ones that read the row without asking the
 * placement question until this suite existed. They are not interchangeable:
 *
 *   1. `GET /api/me/context` — the caller-context hints, i.e. the system
 *      prompt handed to the MODEL. A leak here is not a page the user has to
 *      open: the agent is told it may invoke the package, by name and
 *      description;
 *   2. the per-type index page — what the CLI's skill sync writes into the
 *      caller's Claude Code, and what the agent editor's integration picker
 *      offers;
 *   3. `GET /api/spaces/{id}/packages`, its per-package detail and its
 *      `run-config` — whose projection carries `draft_manifest`, so a leak is
 *      the draft's display name and description, not merely its id.
 *
 * Plus the fourth execution door, `POST /api/runs/remote`, which asks the same
 * question as the three agent doors and answers a missing placement in the
 * words of a package that does not exist.
 *
 * NEGATIVE CONTROL for the whole file: make `placementReadFilter`
 * (`services/package-placement.ts`) answer `true` unconditionally. Every `it`
 * below that asserts absence goes red, which is what proves they are reading
 * the conjunct and not some other refusal.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, packageShares, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { activatePackage, getSpacePackageSettings } from "../../../src/services/space-packages.ts";

const app = getTestApp();

/** The string that must never come back: it lives only in the private draft. */
const SECRET = "a private draft nobody offered";
const SKILL = "@stranger/private-skill";
const AGENT = "@stranger/private-agent";

let ctx: TestContext;

async function seedOrphan(id: string, type: "agent" | "skill", homeSpaceId: string) {
  await seedPackage({
    id,
    orgId: ctx.orgId,
    type,
    homeSpaceId,
    draftManifest: {
      name: id,
      version: "0.1.0",
      type,
      display_name: "Secret Worker",
      description: SECRET,
      ...(type === "skill" ? {} : { input: { schema: { type: "object", properties: {} } } }),
    },
    draftContent: type === "skill" ? `---\nname: x\ndescription: d\n---\n\n${SECRET}` : SECRET,
  });
  // The row, and ONLY the row: no home here, no offer here.
  await seedSpacePackage(ctx.defaultSpaceId, id);
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  // Somebody else's personal space — private by construction, and the one
  // place an unpublished draft is supposed to stay.
  const stranger = await createTestUser();
  const personal = await seedSpace({
    orgId: ctx.orgId,
    name: "Stranger",
    ownerUserId: stranger.id,
    visibility: "private",
  });
  await seedOrphan(SKILL, "skill", personal.id);
  await seedOrphan(AGENT, "agent", personal.id);
});

describe("the caller context handed to the model", () => {
  it("names neither the orphaned agent nor the orphaned skill", async () => {
    const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as {
      agents: { packageId: string }[];
      skills: { packageId: string }[];
    };
    expect(body.agents.map((a) => a.packageId)).not.toContain(AGENT);
    expect(body.skills.map((s) => s.packageId)).not.toContain(SKILL);
    // The hints carry `display_name` and `description` straight off the draft
    // manifest, so the id check alone would miss the actual disclosure.
    expect(text).not.toContain(SECRET);
  });
});

describe("the type index — the CLI's skill sync and the agent editor's picker", () => {
  it("does not list the orphan, nor name it anywhere in the payload", async () => {
    const index = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
    expect(index.status).toBe(200);
    const text = await index.clone().text();
    const body = (await index.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).not.toContain(SKILL);
    // The listing carries the manifest's display name and description, so the
    // id check alone would miss the actual disclosure.
    expect(text).not.toContain(SECRET);
  });
});

describe("the space-package reads", () => {
  it("omits the orphan from the listing, draft manifest and all", async () => {
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as { data: { packageId: string }[] };
    expect(body.data.map((r) => r.packageId)).not.toContain(SKILL);
    expect(body.data.map((r) => r.packageId)).not.toContain(AGENT);
    expect(text).not.toContain(SECRET);
  });

  it("answers 404 on the per-package detail", async () => {
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${SKILL}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "package_not_placed" });
  });

  it("answers 404 on the resolved run-config", async () => {
    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/${AGENT}/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(404);
    expect(await res.clone().text()).not.toContain(SECRET);
  });
});

describe("`POST /api/runs/remote` — the fourth execution door", () => {
  /** The table: every state a package id can be in, on the one door. */
  async function remote(packageId: string) {
    const res = await app.request("/api/runs/remote", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { kind: "registry", packageId, stage: "draft" },
        spaceId: ctx.defaultSpaceId,
        input: {},
      }),
    });
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as {
      code?: string;
      detail?: string;
    };
    return { status: res.status, code: body.code, detail: body.detail };
  }

  it("answers an ORPHAN exactly as it answers an id that does not exist", async () => {
    const orphan = await remote(AGENT);
    const ghost = await remote("@stranger/no-such-agent");
    expect(orphan).toEqual({
      status: 404,
      code: "package_not_found",
      detail: `Package '${AGENT}' not found in this organization`,
    });
    // Byte for byte apart from the id: a distinguishable refusal here is an
    // existence oracle over every package the organization owns, on a route
    // that takes the id straight from the caller.
    expect(ghost).toEqual({
      status: 404,
      code: "package_not_found",
      detail: `Package '@stranger/no-such-agent' not found in this organization`,
    });
  });

  it("names the switch for a PLACED package that is merely switched off", async () => {
    const placed = "@testorg/placed-but-off";
    await seedPackage({
      id: placed,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: { name: placed, version: "0.1.0", type: "agent" },
      draftContent: "prompt",
    });
    await seedSpacePackage(ctx.defaultSpaceId, placed, { enabled: false });

    const got = await remote(placed);
    expect({ status: got.status, code: got.code }).toEqual({
      status: 404,
      code: "package_not_active_in_space",
    });
    // The caller can already SEE this one, so the refusal names the repair.
    expect(got.detail).toContain(`POST /api/spaces/${ctx.defaultSpaceId}/packages`);
  });

  it("lets a PLACED and ACTIVE package through the door", async () => {
    const live = "@testorg/live";
    await seedPackage({
      id: live,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        name: live,
        version: "0.1.0",
        type: "agent",
        display_name: "Live",
        description: "d",
        schemaVersion: "1.0",
        dependencies: { skills: {}, mcp_servers: {}, integrations: {} },
      },
      draftContent: "prompt",
    });
    await seedSpacePackage(ctx.defaultSpaceId, live, { enabled: true });

    const got = await remote(live);
    // Whatever happens past the gate, it is no longer a placement or an
    // activation refusal — the two codes this door owns are gone.
    expect(got.code).not.toBe("package_not_found");
    expect(got.code).not.toBe("package_not_active_in_space");
  });
});

describe("`POST /api/spaces/{id}/packages` — the activation door", () => {
  /** The one activation door, on the space the orphan rows sit in. */
  const activate = (packageId: string) =>
    app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId }),
    });

  /**
   * The refusal, minus the two members that are per-request by construction
   * (`instance` and `requestId` echo the request id). Everything else has to
   * match byte for byte between the two calls, so it is all compared.
   */
  const problem = async (res: Response): Promise<Record<string, unknown>> => {
    const { instance: _i, requestId: _r, ...body } = (await res.json()) as Record<string, unknown>;
    return { status: res.status, ...body };
  };

  it("answers an ORPHAN the caller cannot reach exactly as it answers a ghost id", async () => {
    // The row is here; the package is homed in somebody else's PRIVATE personal
    // space and offered to nobody. A row is a placement's consequence, never its
    // source — so the door must not read it as one, and its refusal must not
    // separate "there is a package you may not have" from "there is no such
    // package": the id travels in the body, so a distinguishable refusal is an
    // existence oracle over every private draft in the organization.
    const orphan = await problem(await activate(AGENT));
    const ghost = await problem(await activate("@stranger/no-such-agent"));
    expect(orphan).toEqual({
      status: 404,
      code: "not_found",
      title: "Not Found",
      type: "https://docs.appstrate.dev/errors/not-found",
      detail: `Package '${AGENT}' not found`,
    });
    expect(ghost).toEqual({ ...orphan, detail: `Package '@stranger/no-such-agent' not found` });
  });

  it("writes NOTHING on that refusal", async () => {
    await activate(AGENT);
    // No offer was grafted on…
    expect(await db.select().from(packageShares).where(eq(packageShares.packageId, AGENT))).toEqual(
      [],
    );
    // …the orphan row is exactly as it was seeded…
    const [row] = await db
      .select()
      .from(spacePackages)
      .where(
        and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, AGENT)),
      );
    expect(row?.enabled).toBe(true);
    // …and nothing was recorded about a package the caller may not know exists.
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("refuses at the SERVICE seam too, under the row lock that decides", async () => {
    // The route's read and the transaction's read are two different reads of
    // one rule, and the second is the authoritative one: a revoke racing the
    // first must make the activation refuse rather than commit a placement
    // nothing backs. Calling the service directly is how that half is asserted
    // without a race — `activatePackage` with no `shareBy` has exactly one way
    // to refuse a reachable id, and it is the placement read.
    await expect(
      activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT),
    ).rejects.toThrow(/not found in this organization/);
    expect(await db.select().from(packageShares).where(eq(packageShares.packageId, AGENT))).toEqual(
      [],
    );
  });

  it("REPAIRS the orphan for a caller who holds `share` in its home", async () => {
    // The other half of the contract, and the reason the refusal above is not
    // a dead end: the door that refuses to honour an orphan is the same one
    // that can fix it. This package is homed in a TEAM space of the
    // organization, which the owner in session reaches — so they hold `share`
    // over it, and one call writes the offer that places it in the space
    // holding the orphan row and switches that row on.
    const CATALOG = "@testorg/team-orphan";
    const team = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    await seedPackage({
      id: CATALOG,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: team.id,
      draftManifest: { name: CATALOG, version: "0.1.0", type: "agent" },
      draftContent: "prompt",
    });
    // The orphan, switched OFF, so "the row is now on" says something.
    await seedSpacePackage(ctx.defaultSpaceId, CATALOG, { enabled: false });

    const res = await activate(CATALOG);
    // 201: this call is what put the package on. An orphan row is not "on"
    // anywhere, so `wasActive` was false however the row read.
    expect(res.status, await res.clone().text()).toBe(201);

    // The offer that places it, attributed to the caller who vouched for it —
    // `shared_by` NULL is the re-home reconciliation's signature, not this
    // door's.
    expect(
      (await db.select().from(packageShares).where(eq(packageShares.packageId, CATALOG))).map(
        (row) => ({ spaceId: row.spaceId, sharedBy: row.sharedBy }),
      ),
    ).toEqual([{ spaceId: ctx.defaultSpaceId, sharedBy: ctx.user.id }]);

    // The row the space already had, kept and switched on: a repair costs the
    // space none of its settings.
    const [row] = await db
      .select()
      .from(spacePackages)
      .where(
        and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, CATALOG)),
      );
    expect(row?.enabled).toBe(true);

    // Two acts, each audited as itself and in the order they happened: the
    // audience changed, then the package became active here.
    expect(
      (
        await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.resourceId, CATALOG))
          .orderBy(asc(auditEvents.id))
      ).map((row) => ({ action: row.action, after: row.after })),
    ).toEqual([
      { action: "package.shared", after: { spaceId: ctx.defaultSpaceId, targetKind: "space" } },
      { action: "package.activated", after: { spaceId: ctx.defaultSpaceId } },
    ]);
  });
});

describe("the per-space settings read", () => {
  /**
   * `getSpacePackageSettings` is the last reader of `space_packages` that used
   * to take a bare space id and trust its callers' guards. It carries the org
   * boundary and the placement rule in its own query now, so an orphan row
   * reads as no row at all — the model, the proxy and the stored input values
   * of a package this space no longer holds are not its settings.
   */
  const SETTINGS = {
    modelId: "mdl_orphan",
    proxyId: "prx_orphan",
    inputSettings: { values: { folder: "secret" }, locked: ["folder"] },
  };

  it("answers the defaults for an ORPHAN row, settings and all", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, SETTINGS);

    expect(
      await getSpacePackageSettings({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT),
    ).toEqual({ values: {}, locked: [], modelId: null, generationConfig: null, proxyId: null });
  });

  it("answers the row itself once the package is PLACED here", async () => {
    // The discriminating control: the same row, the same read, one offer
    // apart. Without it the assertion above would pass on any refusal at all.
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, SETTINGS);
    await db.insert(packageShares).values({ packageId: AGENT, spaceId: ctx.defaultSpaceId });

    expect(
      await getSpacePackageSettings({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT),
    ).toEqual({
      values: { folder: "secret" },
      locked: ["folder"],
      modelId: "mdl_orphan",
      generationConfig: null,
      proxyId: "prx_orphan",
    });
  });
});
