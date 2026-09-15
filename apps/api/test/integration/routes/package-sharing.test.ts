// SPDX-License-Identifier: Apache-2.0

/**
 * Sharing a package over HTTP (RBAC spec §6.10).
 *
 * Three claims, and the suite is organised around them:
 *
 *   1. AUTHORITY is the home space's `<type>:share`, and nothing else — a
 *      viewer of the home is refused, a caller who cannot reach the package at
 *      all gets 404 instead of 403, and no API key ever holds the verb.
 *   2. OFFERED IS NOT ACTIVATED. A share makes the package READABLE for the
 *      recipient and never runnable: the run route stays 404 until they install
 *      it themselves, what they then run is the author's LATEST PUBLISHED
 *      version (a later publish reaches them), and revoking removes the
 *      installation with the offer.
 *   3. NOTHING LEAKS. Another member's personal space is not targetable by id,
 *      the sharer never sees such an id back, and an organization admin who was
 *      shared a package homed in somebody's personal space reads it without
 *      thereby reaching that space.
 *
 * A fourth section covers the copy key (`org_settings.restrict_package_copy`),
 * which exists because `share` protects the link and not the content.
 */

import { asRecord } from "@appstrate/core/safe-json";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  notifications,
  organizationMembers,
  organizations,
  packageDistTags,
  packages,
  packageShares,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { sql } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { assertDbMissing, expectProblem, getDbRow } from "../../helpers/assertions.ts";
import { expectRejectedField } from "../../helpers/body-validation.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedSpacePackage,
  seedPackage,
  seedPackageVersion,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  buildMinimalZip,
  uploadPackageZip,
  deleteVersionZip,
} from "../../../src/services/package-storage.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { runs } from "@appstrate/db/schema";
import { seedSchedule } from "../../helpers/seed.ts";
import { computeIntegrity } from "@appstrate/core/integrity";

const app = getTestApp();

const AGENT = "@shares/worker";
const SKILL = "@shares/helper";
/** Homed in the AUTHOR's personal space — the package an admin may not reach. */
const PRIVATE_AGENT = "@shares/private";

type Headers = Record<string, string>;

interface Principal {
  userId: string;
  /** Their `user.name` — what a share notification carries as the sharer. */
  name: string;
  headers: (spaceId?: string) => Headers;
  /** Their own personal space, provisioned by the `GET /api/spaces` repair. */
  personalSpaceId: string;
}

let ctx: TestContext;
/**
 * The home of `AGENT` and `SKILL`. A CLOSED space of its own, deliberately not
 * the organization's default one: `spaces_default_is_open` forces the default
 * space open, so every org member would reach it (and the package installed
 * there) through its `default_role` alone — which would make every "cannot see
 * it" assertion below vacuous.
 */
let homeId: string;
/** A team space, used as a non-personal share target. */
let teamId: string;

let author: Principal;
let viewer: Principal;
let recipient: Principal;
let guest: Principal;
/** An organization admin who is not the owner — the §3.6 negative control. */
let admin: Principal;
/** A member of `teamId` and of nothing else. */
let teamMember: Principal;

/** Headers for the org owner, acting in the home space. */
const owner = (spaceId = homeId): Headers => ({
  Cookie: ctx.cookie,
  "X-Org-Id": ctx.orgId,
  "X-Space-Id": spaceId,
});

/**
 * A session with an org role, an optional preset in one space, and its own
 * personal space resolved through the route that repairs it — which is how a
 * real recipient's space comes to exist.
 */
async function principal(opts: {
  orgRole: "admin" | "member" | "guest";
  space?: { id: string; preset: "builder" | "viewer" | "operator" };
}): Promise<Principal> {
  const user = await createTestUser();
  await addOrgMember(ctx.orgId, user.id, opts.orgRole);
  if (opts.space) {
    await seedSpaceMember({
      spaceId: opts.space.id,
      userId: user.id,
      presetRole: opts.space.preset,
    });
  }
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: user.cookie, "X-Org-Id": ctx.orgId },
  });
  expect(listed.status, await listed.clone().text()).toBe(200);
  const spaces = (await listed.json()) as { data: { id: string; personal: boolean }[] };
  const own = spaces.data.find((space) => space.personal);
  expect(own).toBeDefined();
  return {
    userId: user.id,
    name: user.name,
    personalSpaceId: own!.id,
    headers: (spaceId = own!.id) => ({
      Cookie: user.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": spaceId,
    }),
  };
}

/** `POST …/shares` with a `user` target. */
const shareWithUser = (headers: Headers, packageId: string, userId: string) =>
  app.request(`/api/packages/${packageId}/shares`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ target: { kind: "user", user_id: userId } }),
  });

/** `POST …/shares` with a `space` target. */
const shareWithSpace = (headers: Headers, packageId: string, spaceId: string) =>
  app.request(`/api/packages/${packageId}/shares`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ target: { kind: "space", space_id: spaceId } }),
  });

const listShares = (headers: Headers, packageId: string) =>
  app.request(`/api/packages/${packageId}/shares`, { headers });

const revokeShare = (headers: Headers, packageId: string, target: string) =>
  app.request(`/api/packages/${packageId}/shares/${target}`, { method: "DELETE", headers });

/**
 * Take up an offer — which is ACTIVATING it, through the one activation door
 * (`POST /api/spaces/{spaceId}/packages`). There is no accept route: in the
 * caller's own personal space ownership stands in for the activation grant, so
 * a guest reaches it with the `operator` preset alone.
 */
const takeUpOffer = (headers: Headers, packageId: string, spaceId?: string) =>
  app.request(`/api/spaces/${spaceId ?? headers["X-Space-Id"]}/packages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ packageId }),
  });

/** Ids on the agents INDEX page — `GET /api/agents`, read from one space. */
async function agentIndexIds(headers: Headers): Promise<string[]> {
  const res = await app.request("/api/agents", { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((agent) => agent.id);
}

/** One placement cell of a library row. */
interface LibraryPlacement {
  space_id: string;
  via: "home" | "shared" | "system";
  state: "active" | "inactive" | "none";
  shared_by: { user_id: string; name: string } | null;
}

/** The current space's library view — a map of placements. */
async function library(headers: Headers): Promise<{
  packages: Record<string, { id: string; placements: LibraryPlacement[] }[]>;
}> {
  const res = await app.request(`/api/spaces/${headers["X-Space-Id"]}/library`, {
    headers: { Cookie: headers.Cookie!, "X-Org-Id": headers["X-Org-Id"]! },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as never;
}

/** Publish a version and move the `latest` dist-tag onto it. */
async function publish(packageId: string, version: string): Promise<number> {
  const pkg = await getDbRow(packages, eq(packages.id, packageId));
  const manifest = { ...asRecord(pkg.draftManifest), name: packageId, version, type: pkg.type };
  const zip = buildMinimalZip(
    manifest,
    pkg.draftContent ?? "",
    pkg.type === "skill" ? "SKILL.md" : "prompt.md",
  );
  await uploadPackageZip(packageId, version, zip);
  const row = await seedPackageVersion({
    packageId,
    version,
    manifest,
    integrity: computeIntegrity(zip),
    artifactSize: zip.byteLength,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId, tag: "latest", versionId: row.id })
    .onConflictDoUpdate({
      target: [packageDistTags.packageId, packageDistTags.tag],
      set: { versionId: row.id, updatedAt: new Date() },
    });
  return row.id;
}

/** Is the package ACTIVE in `spaceId` — a placement row that says `enabled`? */
async function activeIn(spaceId: string, packageId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: spacePackages.enabled })
    .from(spacePackages)
    .where(and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId)));
  return rows[0]?.enabled === true;
}

/** The placement this library row carries for `spaceId`, if any. */
const placementIn = (
  row: { placements: LibraryPlacement[] } | undefined,
  spaceId: string,
): LibraryPlacement | undefined => row?.placements.find((p) => p.space_id === spaceId);

/** Flip the organization's copy key. */
async function setRestrictCopy(value: boolean): Promise<void> {
  await db
    .update(organizations)
    .set({
      orgSettings: sql`COALESCE(${organizations.orgSettings}, '{}'::jsonb) || ${JSON.stringify({ restrict_package_copy: value })}::jsonb`,
    })
    .where(eq(organizations.id, ctx.orgId));
}

// One run launches (the positive control of the execution gate), so the
// orchestrator is the inert one rather than Docker.
beforeAll(() => {
  _setOrchestratorForTesting(createFakeOrchestrator());
});

afterAll(() => {
  _setOrchestratorForTesting(null);
});

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "shares" });
  homeId = (await seedSpace({ orgId: ctx.orgId, name: "Home", visibility: "closed" })).id;
  teamId = (await seedSpace({ orgId: ctx.orgId, name: "Team", visibility: "closed" })).id;

  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: homeId,
    createdBy: ctx.user.id,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Shared worker" },
    draftContent: "Do the thing.",
  });
  await seedSpacePackage(homeId, AGENT);
  await seedPackage({
    id: SKILL,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: homeId,
    createdBy: ctx.user.id,
    draftManifest: { name: SKILL, version: "0.1.0", type: "skill", description: "A skill" },
    draftContent: "---\nname: helper\ndescription: A skill\n---\n\nbody",
  });
  await seedDefaultOrgModel(ctx);
  // Both fixtures carry a published version, because EVERY offer needs one:
  // outside its home a package runs its latest published version, so
  // `POST …/shares` refuses a package with nothing published
  // (`package_has_no_version`), whatever the target. A draft-only fixture would
  // make every share in this suite a 409.
  await publish(AGENT, "0.1.0");
  await publish(SKILL, "0.1.0");

  author = await principal({ orgRole: "member", space: { id: homeId, preset: "builder" } });
  viewer = await principal({ orgRole: "member", space: { id: homeId, preset: "viewer" } });
  recipient = await principal({ orgRole: "member" });
  guest = await principal({ orgRole: "guest" });
  admin = await principal({ orgRole: "admin" });
  teamMember = await principal({ orgRole: "member", space: { id: teamId, preset: "operator" } });
});

describe("authority — `<type>:share` in the home space", () => {
  it("lets the home's builder share", async () => {
    const res = await shareWithUser(author.headers(homeId), AGENT, recipient.userId);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { object: string; target: { kind: string; name: string } };
    expect(body.object).toBe("package_share");
    expect(body.target.kind).toBe("user");
  });

  it("refuses the home's viewer with 403", async () => {
    await expectProblem(await shareWithUser(viewer.headers(homeId), AGENT, recipient.userId), 403);
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
  });

  it("refuses a caller who cannot reach the package with 404, not 403", async () => {
    // `teamMember` reads nothing in the home and the package is installed
    // nowhere they read — the id must not be confirmed to exist.
    await expectProblem(
      await shareWithUser(teamMember.headers(teamId), AGENT, recipient.userId),
      404,
    );
  });

  it("refuses an API key: `share` is not a grantable scope", async () => {
    // Two barriers, and the first one is the mint. `agents:share` is absent
    // from the API-key allowlist, so a key asking for it is a 400 — there is no
    // key in existence that could reach the route.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: homeId,
      createdBy: ctx.user.id,
      scopes: ["agents:read", "agents:write", "agents:configure"],
    });
    const res = await app.request(`/api/packages/${AGENT}/shares`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: { kind: "space", space_id: teamId } }),
    });
    await expectProblem(res, 403);

    const minted = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...owner(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sharer", scopes: ["agents:share"] }),
    });
    await expectProblem(minted, 400, { code: "invalid_request" });
  });

  it("refuses a malformed `space_id` with 400, not the 404 an unreachable space gets", async () => {
    // A retired `app_` spelling resolves to no space. Without the shape check
    // the route reports it as "space not found", which reads as a permission
    // problem and sends the caller looking in the wrong place.
    await expectRejectedField(
      await shareWithSpace(author.headers(homeId), AGENT, "app_legacy"),
      "target.space_id",
    );
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
  });

  it("refuses a malformed `spc_` revoke target with 400, not a 404", async () => {
    // The `spc_` prefix discriminates the segment, and the FULL shape is then
    // asserted: a malformed one sent down the user-id branch would answer
    // "not a member of this organization", a wrong reason for a bad id.
    await expectProblem(await revokeShare(author.headers(homeId), AGENT, "spc_nope"), 400, {
      code: "invalid_request",
      param: "target",
    });
  });

  it("refuses a body with an unknown key or an unknown target kind", async () => {
    await expectRejectedField(
      await app.request(`/api/packages/${AGENT}/shares`, {
        method: "POST",
        headers: { ...author.headers(homeId), "Content-Type": "application/json" },
        body: JSON.stringify({ target: { kind: "user", user_id: recipient.userId }, note: "hi" }),
      }),
      "note",
    );
    await expectProblem(
      await app.request(`/api/packages/${AGENT}/shares`, {
        method: "POST",
        headers: { ...author.headers(homeId), "Content-Type": "application/json" },
        body: JSON.stringify({ target: { kind: "everyone" } }),
      }),
      400,
    );
  });

  describe("an offer needs something published — every target", () => {
    /** Strip the `latest` dist-tag: the package keeps its rows, loses its pin. */
    const unpublish = (packageId: string) =>
      db.delete(packageDistTags).where(eq(packageDistTags.packageId, packageId));

    it("refuses a `user` target when nothing is published, and offers nothing", async () => {
      await unpublish(AGENT);
      await expectProblem(
        await shareWithUser(author.headers(homeId), AGENT, recipient.userId),
        409,
        { code: "package_has_no_version" },
      );
      await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
    });

    it("takes the same offer once a version exists", async () => {
      await unpublish(AGENT);
      await expectProblem(
        await shareWithUser(author.headers(homeId), AGENT, recipient.userId),
        409,
        { code: "package_has_no_version" },
      );
      await publish(AGENT, "0.2.0");
      expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(
        200,
      );
    });

    it("refuses a `space` target for the same reason — the rule has one half now", async () => {
      // THE generalization of decision 6. Every space but the home runs the
      // latest published version, so an offer with nothing published is an
      // offer of nothing wherever it points — a person or a team, one rule.
      // The org owner is
      // the sharer because the sharer must also REACH the destination, and the
      // home's builder is not a member of the team space.
      await unpublish(AGENT);
      await expectProblem(await shareWithSpace(owner(), AGENT, teamId), 409, {
        code: "package_has_no_version",
      });
      await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));

      await publish(AGENT, "0.2.0");
      expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);
    });

    it("answers the AUTHORITY refusal first: a viewer gets 403, not 409", async () => {
      await unpublish(AGENT);
      await expectProblem(
        await shareWithUser(viewer.headers(homeId), AGENT, recipient.userId),
        403,
      );
    });
  });

  it("refuses sharing a package with its own home (409)", async () => {
    await expectProblem(await shareWithSpace(author.headers(homeId), AGENT, homeId), 409, {
      code: "share_target_is_home",
    });
  });

  it("is idempotent — the same pair twice is one row and one audit event", async () => {
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    const rows = await db.select().from(packageShares).where(eq(packageShares.packageId, AGENT));
    expect(rows).toHaveLength(1);
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.shared"));
    expect(events).toHaveLength(1);
  });

  it("renders a personal-space target as its owner and never as a space id", async () => {
    await shareWithUser(author.headers(homeId), AGENT, recipient.userId);
    const res = await listShares(author.headers(homeId), AGENT);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      data: { target: Record<string, unknown>; shared_by: { user_id: string } | null }[];
    };
    expect(body.data).toHaveLength(1);
    const [entry] = body.data;
    expect(entry!.target.kind).toBe("user");
    expect(entry!.target.user_id).toBe(recipient.userId);
    expect(entry!.target.space_id).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(recipient.personalSpaceId);
    expect(entry!.shared_by?.user_id).toBe(author.userId);
  });

  it("stops naming a sharer who has LEFT the organization", async () => {
    // Same rule as the library map, same reason: the account survives a
    // membership revocation (a `user` row is multi-org), so nothing clears
    // `shared_by` — and this listing is read by everyone who can reach the
    // package. The membership is part of the JOIN, so the name is never loaded
    // rather than being filtered out after the fact.
    await shareWithUser(author.headers(homeId), AGENT, recipient.userId);
    const named = (await (await listShares(owner(), AGENT)).json()) as {
      data: { shared_by: { user_id: string } | null }[];
    };
    expect(named.data[0]!.shared_by?.user_id).toBe(author.userId);

    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, ctx.orgId),
          eq(organizationMembers.userId, author.userId),
        ),
      );

    const anonymous = (await (await listShares(owner(), AGENT)).json()) as {
      data: { target: Record<string, unknown>; shared_by: { user_id: string } | null }[];
    };
    // The offer still stands, and its target is still named — only the sharer
    // is withheld.
    expect(anonymous.data).toHaveLength(1);
    expect(anonymous.data[0]!.target.user_id).toBe(recipient.userId);
    expect(anonymous.data[0]!.shared_by).toBeNull();
  });

  it("records the PERSON in the audit trail of a `user` share, never their space", async () => {
    // The audit log must not publish what the wire withholds (plan decision
    // 5b): the personal space is how "share with Bob" is implemented, and Bob
    // is what was audited.
    await shareWithUser(author.headers(homeId), AGENT, recipient.userId);
    const shared = await getDbRow(auditEvents, eq(auditEvents.action, "package.shared"));
    expect(shared.after).toEqual({ recipientUserId: recipient.userId, targetKind: "user" });
    expect(JSON.stringify(shared.after)).not.toContain(recipient.personalSpaceId);

    expect((await revokeShare(author.headers(homeId), AGENT, recipient.userId)).status).toBe(204);
    const unshared = await getDbRow(auditEvents, eq(auditEvents.action, "package.unshared"));
    expect(unshared.after).toEqual({
      recipientUserId: recipient.userId,
      targetKind: "user",
      placement_removed: false,
    });
  });

  it("records the SPACE in the audit trail of a `space` share", async () => {
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);
    const shared = await getDbRow(auditEvents, eq(auditEvents.action, "package.shared"));
    expect(shared.after).toEqual({ spaceId: teamId, targetKind: "space" });
  });

  it("notifies the recipient of a `user` share", async () => {
    await shareWithUser(author.headers(homeId), AGENT, recipient.userId);
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, recipient.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("package_shared");
    expect(rows[0]!.spaceId).toBe(recipient.personalSpaceId);
    // The bell renders "<sharer> vous a partagé <package>" from this payload
    // alone — it has no query that would resolve a user id.
    expect(rows[0]!.payload).toEqual({
      package_id: AGENT,
      package_type: "agent",
      shared_by_name: author.name,
    });
  });
});

describe("offered is not activated", () => {
  beforeEach(async () => {
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
  });

  /**
   * The launch route, from the recipient's own space. NO selector: a recipient
   * cannot write the package, so `version=draft` is a 403 for them and the
   * published `latest` is the only thing they can run (plan decisions 3 and 4).
   */
  const runAsRecipient = (who: Principal) =>
    app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...who.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  it("shows the offer as an INACTIVE placement in the recipient's library", async () => {
    // An untaken offer is not a section of its own: it is the package's own
    // row, with a placement in the recipient's space saying `via: "shared"` and
    // `state: "none"` — one row, one switch, one act.
    const lib = await library(recipient.headers());
    const row = lib.packages.agent?.find((entry) => entry.id === AGENT);
    expect(row).toBeDefined();
    const placement = placementIn(row, recipient.personalSpaceId);
    expect(placement).toMatchObject({ via: "shared", state: "none" });
    expect(placement!.shared_by?.user_id).toBe(author.userId);

    const detail = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: recipient.headers(),
    });
    expect(detail.status, await detail.clone().text()).toBe(200);
  });

  it("puts the offer in the recipient's LIBRARY, not on their agents index", async () => {
    // An offer is something the recipient HOLDS, not something they can launch,
    // so it belongs to the page that answers "what is placed here, and in what
    // state" — the library, where `state: "none"` renders as a pending offer
    // next to the button that takes it up. The index answers the other
    // question and must not show a row whose launch control would 404.
    // `teamMember` reads neither the home nor the offer and must not learn the
    // id exists on either page.
    expect(await agentIndexIds(recipient.headers())).not.toContain(AGENT);
    expect(
      placementIn(
        (await library(recipient.headers())).packages.agent?.find((row) => row.id === AGENT),
        recipient.personalSpaceId,
      ),
    ).toMatchObject({ via: "shared", state: "none" });

    expect(await agentIndexIds(teamMember.headers(teamId))).not.toContain(AGENT);
    expect((await library(teamMember.headers(teamId))).packages.agent ?? []).toHaveLength(0);

    // Taking it up is what puts it on the index — the positive control that
    // separates "not yet activated" from "refused for some other reason".
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    expect(await agentIndexIds(recipient.headers())).toContain(AGENT);
  });

  it("refuses the run until the recipient activates it", async () => {
    await expectProblem(await runAsRecipient(recipient), 404);

    const installed = await takeUpOffer(recipient.headers(), AGENT);
    expect(installed.status, await installed.clone().text()).toBe(201);

    const launched = await runAsRecipient(recipient);
    expect(launched.status, await launched.clone().text()).toBe(201);
    await waitForRunPipelineSettled();
  });

  it("refuses `version=draft` to the recipient — the draft is the author's", async () => {
    // THE negative control for plan decision 4: before it, this same call from
    // this same principal launched the author's uncommitted working copy with
    // the recipient's credentials.
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    const drafted = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...recipient.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await expectProblem(drafted, 403, { code: "draft_not_writable" });
    expect(await db.select().from(runs).where(eq(runs.packageId, AGENT))).toHaveLength(0);
  });

  it("follows `latest`: the author publishes, the recipient's next run executes it", async () => {
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);

    const first = await runAsRecipient(recipient);
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toMatchObject({ version_ref: "0.1.0" });
    await waitForRunPipelineSettled();

    await publish(AGENT, "0.2.0");

    // THE reversal this lot performs: the author's publish IS the rollout. The
    // recipient's installation carries no version, so the very next launch —
    // manual and scheduled alike — runs what was just published. Under the pin
    // this assertion read `0.1.0` and the recipient could not take a fix.
    const second = await runAsRecipient(recipient);
    expect(second.status, await second.clone().text()).toBe(201);
    expect(await second.json()).toMatchObject({ version_ref: "0.2.0" });
    await waitForRunPipelineSettled();

    const schedule = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: recipient.personalSpaceId,
      packageId: AGENT,
      userId: recipient.userId,
    });
    await triggerScheduledRun(
      schedule.id,
      AGENT,
      { type: "user", id: recipient.userId },
      ctx.orgId,
      recipient.personalSpaceId,
      undefined,
    );
    await waitForRunPipelineSettled();
    const scheduled = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.versionRef).toBe("0.2.0");

    // …and the detail page shows the recipient the package, not a photograph
    // of it: the published manifest of 0.2.0, with no `version_pin` member at
    // all on the wire.
    const detail = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: recipient.headers(),
    });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("version_pin");
    expect(dto.version).toBe("0.2.0");
  });

  it("never replaces an unavailable published archive with the author's current prompt", async () => {
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    await deleteVersionZip(AGENT, "0.1.0");
    await db
      .update(packages)
      .set({ draftContent: "Unpublished replacement" })
      .where(eq(packages.id, AGENT));
    const response = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: recipient.headers(),
    });
    await expectProblem(response, 422, { code: "version_artifact_unavailable" });
    expect(await db.select().from(runs).where(eq(runs.packageId, AGENT))).toHaveLength(0);
  });

  it("configures the PUBLISHED input schema, and never reads the author's draft", async () => {
    // What the recipient configures has to be what they run. They run the
    // latest PUBLISHED version, so the input schema the settings route
    // validates against is that version's — not the author's working copy,
    // which they have no authority over and, since decision 4, no read of.
    const row = await getDbRow(packages, eq(packages.id, AGENT));
    await db
      .update(packages)
      .set({
        draftManifest: {
          ...asRecord(row.draftManifest),
          input: { schema: { type: "object", properties: { published: { type: "string" } } } },
        },
      })
      .where(eq(packages.id, AGENT));
    await publish(AGENT, "0.2.0");
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    // The author moves on: the draft loses the field and gains a new prompt.
    await db
      .update(packages)
      .set({ draftManifest: row.draftManifest, draftContent: "Current authoring" })
      .where(eq(packages.id, AGENT));

    const settings = await app.request(`/api/agents/${AGENT}/input-settings`, {
      method: "PUT",
      headers: { ...recipient.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: { published: "keep me" }, locked_fields: [] }),
    });
    expect(settings.status, await settings.clone().text()).toBe(200);

    const installed = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: recipient.headers(),
    });
    const dto = await installed.json();
    expect(dto).toHaveProperty("input.schema.properties.published", { type: "string" });
    expect(dto).toHaveProperty("input.values", { published: "keep me" });
    // The draft is not theirs to read, explicitly asked for or not.
    expect(dto).not.toHaveProperty("prompt", "Current authoring");
    await expectProblem(
      await app.request(`/api/packages/agents/${AGENT}?version=draft`, {
        headers: recipient.headers(),
      }),
      403,
      { code: "draft_not_writable" },
    );
  });

  it("lets the author delete a published version the recipient was running", async () => {
    // No placement names a version, so nothing is ever "in use" and a version
    // delete is never refused on that ground. What the recipient runs after the
    // delete is whatever `latest` points at — the dist-tag is reassigned by the
    // delete itself.
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    await publish(AGENT, "0.2.0");
    const removed = await app.request(`/api/packages/agents/${AGENT}/versions/0.1.0`, {
      method: "DELETE",
      headers: author.headers(homeId),
    });
    expect(removed.status, await removed.clone().text()).toBe(204);

    const launched = await runAsRecipient(recipient);
    expect(launched.status, await launched.clone().text()).toBe(201);
    expect(await launched.json()).toMatchObject({ version_ref: "0.2.0" });
    await waitForRunPipelineSettled();
  });

  it("changes the placement's STATE when the offer is taken up, and keeps one row", async () => {
    // The offer and the activation are the same row throughout: only `state`
    // moves, `none` → `active`. Two rows with two buttons for one act is the
    // duplicate this pin exists to catch.
    const before = await library(recipient.headers());
    const beforeRows = before.packages.agent?.filter((entry) => entry.id === AGENT) ?? [];
    expect(beforeRows).toHaveLength(1);
    expect(placementIn(beforeRows[0], recipient.personalSpaceId)?.state).toBe("none");

    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    const after = await library(recipient.headers());
    const afterRows = after.packages.agent?.filter((entry) => entry.id === AGENT) ?? [];
    expect(afterRows).toHaveLength(1);
    expect(placementIn(afterRows[0], recipient.personalSpaceId)?.state).toBe("active");
    expect(placementIn(afterRows[0], recipient.personalSpaceId)?.via).toBe("shared");
  });

  it("has no `shared` section in either library shape", async () => {
    // An offer is a placement with `state: "none"`, on the package's own row.
    // Neither shape carries a section of its own for it — ABSENT, not empty.
    const res = await app.request("/api/library", { headers: owner() });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["object", "packages", "spaces"]);

    const space = await app.request(`/api/spaces/${recipient.personalSpaceId}/library`, {
      headers: recipient.headers(),
    });
    expect(space.status, await space.clone().text()).toBe(200);
    expect(Object.keys((await space.json()) as object).sort()).toEqual([
      "object",
      "packages",
      "spaces",
    ]);
  });

  it("revokes the offer AND the installation behind it", async () => {
    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    const revoked = await revokeShare(author.headers(homeId), AGENT, recipient.userId);
    expect(revoked.status, await revoked.clone().text()).toBe(204);
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
    await assertDbMissing(
      spacePackages,
      and(
        eq(spacePackages.packageId, AGENT),
        eq(spacePackages.spaceId, recipient.personalSpaceId),
      )!,
    );
    // …and the recipient is back to not being able to run it.
    await expectProblem(await runAsRecipient(recipient), 404);
  });

  it("answers 404 on a revoke of a target that holds no share", async () => {
    await expectProblem(await revokeShare(author.headers(homeId), AGENT, teamId), 404);
  });

  it("does not PROVISION a space on the way to that 404", async () => {
    // A member who has never listed their spaces has none. Revoking a share
    // they were never offered must answer 404 without creating one: a withdraw
    // is not a grant, and the row it wrote was a side effect of a refusal.
    const stranger = await createTestUser();
    await addOrgMember(ctx.orgId, stranger.id, "member");
    await assertDbMissing(spaces, eq(spaces.ownerUserId, stranger.id));

    await expectProblem(await revokeShare(author.headers(homeId), AGENT, stranger.id), 404);
    await assertDbMissing(spaces, eq(spaces.ownerUserId, stranger.id));
  });

  it("refuses to install into a personal space nobody offered it to (404)", async () => {
    await expectProblem(await takeUpOffer(teamMember.headers(), AGENT), 404);
  });

  it("lets an API key install only the ALREADY-PLACED — it never holds `share`", async () => {
    // A key is pinned to its space and `<type>:share` is not a grantable scope,
    // so the install route's share-creating branch is closed to it by
    // construction: it installs what its space is already offered, and answers
    // 404 for anything else. `teamId` is the key's space here — the AGENT is
    // homed in `homeId` and offered nowhere yet.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: teamId,
      createdBy: ctx.user.id,
      scopes: ["agents:read", "agents:configure"],
    });
    const install = () =>
      app.request(`/api/spaces/${teamId}/packages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: AGENT }),
      });
    await expectProblem(await install(), 404);
    // Narrowed to the key's OWN space: the suite's `beforeEach` already offered
    // the package to `recipient`, so a bare package-id predicate would pass on
    // that row and prove nothing.
    await assertDbMissing(
      packageShares,
      and(eq(packageShares.packageId, AGENT), eq(packageShares.spaceId, teamId))!,
    );

    // Once a principal who DOES hold `share` has offered it, the same key
    // installs it.
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);
    const placed = await install();
    expect(placed.status, await placed.clone().text()).toBe(201);
  });

  it("keeps every route that needs the INSTALLATION shut until it is installed", async () => {
    // The launch route above is one of them; `POST …/schedules` is the other
    // half of "offered is not activated", and it resolves the agent through the
    // installation too (`requireAgent`). A share must not arm a cron.
    const schedule = () =>
      app.request(`/api/agents/${AGENT}/schedules`, {
        method: "POST",
        headers: { ...recipient.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *" }),
      });
    await expectProblem(await schedule(), 404);

    expect((await takeUpOffer(recipient.headers(), AGENT)).status).toBe(201);
    const created = await schedule();
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it("lets a GUEST activate it in their own space — ownership stands in for the grant", async () => {
    // The acceptance criterion of the whole lot, as the plan words it: "an
    // external invited as a guest sees EXACTLY ONE agent after the share, and
    // nothing else in the library". So the assertion is on the library's shape
    // and not only on the row — a guest who could see a second package would
    // pass a row check just as well. The `operator` preset a guest holds in
    // their own space carries none of `agents:configure` / `<type>:write`; what
    // authorizes the activation is that the space is theirs.
    expect((await shareWithUser(author.headers(homeId), AGENT, guest.userId)).status).toBe(200);

    const before = await library(guest.headers());
    // ONE row, one placement, offered and not yet switched on. Nothing else is
    // in the library: not one other package, of any type.
    expect(Object.values(before.packages).flat()).toHaveLength(1);
    expect(before.packages.agent?.map((entry) => entry.id)).toEqual([AGENT]);
    expect(placementIn(before.packages.agent?.[0], guest.personalSpaceId)).toMatchObject({
      via: "shared",
      state: "none",
    });
    expect(await activeIn(guest.personalSpaceId, AGENT)).toBe(false);

    const activated = await takeUpOffer(guest.headers(), AGENT);
    expect(activated.status, await activated.clone().text()).toBe(201);
    expect(await activeIn(guest.personalSpaceId, AGENT)).toBe(true);

    // Taken up, the SAME row changes state. That move is the whole observable
    // difference — no row appears, none disappears.
    const after = await library(guest.headers());
    expect(Object.values(after.packages).flat()).toHaveLength(1);
    expect(placementIn(after.packages.agent?.[0], guest.personalSpaceId)).toMatchObject({
      via: "shared",
      state: "active",
    });
  });

  it("answers 200 rather than 409 when the guest activates twice", async () => {
    // Asking for a state the system is already in is not an error. Before the
    // two doors this was `409 already_installed`, which made "make sure it is
    // on" a call a client had to special-case.
    expect((await shareWithUser(author.headers(homeId), AGENT, guest.userId)).status).toBe(200);
    expect((await takeUpOffer(guest.headers(), AGENT)).status).toBe(201);
    const again = await takeUpOffer(guest.headers(), AGENT);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ object: "space_package", enabled: true });
  });

  it("lets that guest DEACTIVATE and reactivate it at home, but not reconfigure it", async () => {
    // Activation has its own pair of doors, and the ownership exemption covers
    // both — a guest who could take up an offer can put it back down. `PUT` is
    // `configure` alone: it spends the organization's LLM budget, and ownership
    // does not waive it. Deactivating KEEPS the row and its settings, which is
    // what makes putting a package down cheap.
    expect((await shareWithUser(author.headers(homeId), AGENT, guest.userId)).status).toBe(200);
    expect((await takeUpOffer(guest.headers(), AGENT)).status).toBe(201);

    const off = await app.request(`/api/spaces/${guest.personalSpaceId}/packages/${AGENT}`, {
      method: "DELETE",
      headers: guest.headers(),
    });
    expect(off.status, await off.clone().text()).toBe(204);
    expect(await activeIn(guest.personalSpaceId, AGENT)).toBe(false);
    // The row survives — deactivating is not a delete.
    await getDbRow(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, guest.personalSpaceId))!,
    );

    // 201 again: the status says what the CALL did, not whether a row was
    // created. This one turned the package back on.
    const back = await takeUpOffer(guest.headers(), AGENT);
    expect(back.status, await back.clone().text()).toBe(201);
    expect(await activeIn(guest.personalSpaceId, AGENT)).toBe(true);

    // `configure` is NOT waived by ownership, and `enabled` is no longer a
    // field of this body at all — sending it is a 400 from `.strict()`.
    const patch = (body: Record<string, unknown>) =>
      app.request(`/api/spaces/${guest.personalSpaceId}/packages/${AGENT}`, {
        method: "PUT",
        headers: { ...guest.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await expectProblem(await patch({ modelId: null }), 403);
  });

  it("refuses a guest who was offered NOTHING (404), grant or no grant", async () => {
    // The negative control for the exemption above: ownership waives the
    // activation GRANT, never the placement. Without an offer the package is
    // not placed in the guest's space and the id is not confirmed to exist.
    await expectProblem(await takeUpOffer(guest.headers(), AGENT), 404);
    await assertDbMissing(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, guest.personalSpaceId))!,
    );
  });

  it("checks the offer INSIDE the transaction that activates — a revoked share cannot be taken up", async () => {
    // The check sits next to the insert it authorizes, so that a revoke
    // committing between the two cannot leave a placement the share no longer
    // backs. Racing the two is not reproducible in-process; what is asserted is
    // the property the single transaction guarantees — after the revoke, the
    // activation finds no offer and writes nothing.
    expect((await revokeShare(author.headers(homeId), AGENT, recipient.userId)).status).toBe(204);
    await expectProblem(await takeUpOffer(recipient.headers(), AGENT), 404);
    await assertDbMissing(
      spacePackages,
      and(
        eq(spacePackages.packageId, AGENT),
        eq(spacePackages.spaceId, recipient.personalSpaceId),
      )!,
    );
  });

  it("refuses the activation route into somebody's personal space without an offer", async () => {
    await expectProblem(await takeUpOffer(teamMember.headers(), AGENT), 404);
  });
});

describe("a share whose version disappeared after the offer", () => {
  // `POST …/shares` refuses an offer when nothing is published, so this shape
  // survives for exactly one reason: the `latest` went away AFTER the offer.
  // The placement then names nothing to run, and the launch must say so rather
  // than fall back to the author's draft.
  it("activates, then answers 404 `no_published_version` at launch — never the draft", async () => {
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    const activated = await takeUpOffer(recipient.headers(), AGENT);
    expect(activated.status, await activated.clone().text()).toBe(201);

    await db.delete(packageDistTags).where(eq(packageDistTags.packageId, AGENT));
    await db
      .update(packages)
      .set({ draftContent: "The author's working copy, which must not run here" })
      .where(eq(packages.id, AGENT));

    const launched = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...recipient.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await expectProblem(launched, 404, { code: "no_published_version" });
    expect(await db.select().from(runs).where(eq(runs.packageId, AGENT))).toHaveLength(0);
  });
});

describe("activating is the fourth door closed: it needs `share`, or a placement", () => {
  /** `POST /api/spaces/{spaceId}/packages` — the one activation door. */
  const activate = (headers: Headers, spaceId: string, packageId = AGENT) =>
    app.request(`/api/spaces/${spaceId}/packages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ packageId }),
    });

  const sharesOf = async (packageId: string) =>
    (await db.select().from(packageShares).where(eq(packageShares.packageId, packageId))).map(
      (row) => row.spaceId,
    );

  it("creates the share alongside the placement for a caller who holds `share`", async () => {
    // The organization owner holds `share` in every space, so activating a
    // package that is placed NOWHERE in Team is the act of offering it there
    // and taking it up at once — one call, both rows, one transaction.
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
    const res = await activate(owner(teamId), teamId);
    expect(res.status, await res.clone().text()).toBe(201);

    expect(await sharesOf(AGENT)).toEqual([teamId]);
    await getDbRow(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId))!,
    );
    // …and BOTH acts are audited, each as itself: the audience changed, and
    // the package became active in Team.
    const shared = await getDbRow(auditEvents, eq(auditEvents.action, "package.shared"));
    expect(shared.after).toEqual({ spaceId: teamId, targetKind: "space" });
    const activated = await getDbRow(auditEvents, eq(auditEvents.action, "package.activated"));
    expect(activated.after).toEqual({ spaceId: teamId });
  });

  it("refuses a builder of the target who holds no `share` in the package's home", async () => {
    // THE hole decision 1 closes. A builder of Team holds the activation grant
    // there and still cannot pull the home's package into Team, because the
    // audience is the HOME's to decide. Two shapes, and the difference is
    // whether they can SEE the package at all:
    //   - unreachable from Team → 404, so the id is not confirmed to exist;
    //   - reachable (the home offered it) but not theirs to hand on → 403,
    //     after `assertPackageShareAccess`.
    const teamBuilder = await principal({
      orgRole: "member",
      space: { id: teamId, preset: "builder" },
    });
    await expectProblem(await activate(teamBuilder.headers(teamId), teamId, AGENT), 404);
    await assertDbMissing(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId))!,
    );

    // Reachable now — but reading is not sharing, and the home's `share` is
    // what this builder does not hold.
    expect((await shareWithUser(author.headers(homeId), AGENT, teamBuilder.userId)).status).toBe(
      200,
    );
    await expectProblem(await activate(teamBuilder.headers(teamId), teamId, AGENT), 403);
    await assertDbMissing(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId))!,
    );
  });

  it("refuses 404 a package that EXISTS and the caller cannot reach", async () => {
    // Homed in somebody else's personal space: the row is there, and the
    // refusal must not say so — which is why the control below asserts the
    // author reaches the very same id.
    await seedPackage({
      id: PRIVATE_AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: author.personalSpaceId,
      createdBy: author.userId,
      draftManifest: { name: PRIVATE_AGENT, version: "0.1.0", type: "agent" },
      draftContent: "Private.",
    });
    const teamBuilder = await principal({
      orgRole: "member",
      space: { id: teamId, preset: "builder" },
    });
    await expectProblem(await activate(teamBuilder.headers(teamId), teamId, PRIVATE_AGENT), 404);
    const read = await app.request(`/api/packages/agents/${PRIVATE_AGENT}`, {
      headers: author.headers(),
    });
    expect(read.status, await read.clone().text()).toBe(200);
  });

  it("lets the owner of a personal space DEACTIVATE without any grant either", async () => {
    // The mirror of the activation exemption (§3.6): a guest holds the
    // `operator` preset in their own space, which carries no
    // `integrations:uninstall` and no `<type>:write`. Ownership is the
    // authorization, both ways.
    expect((await shareWithUser(author.headers(homeId), AGENT, guest.userId)).status).toBe(200);
    expect((await takeUpOffer(guest.headers(), AGENT)).status).toBe(201);

    const removed = await app.request(`/api/spaces/${guest.personalSpaceId}/packages/${AGENT}`, {
      method: "DELETE",
      headers: guest.headers(),
    });
    expect(removed.status, await removed.clone().text()).toBe(204);
    expect(await activeIn(guest.personalSpaceId, AGENT)).toBe(false);
    // The OFFER survives — only the sharer withdraws that. So does the
    // placement row itself: deactivating is not a delete.
    expect(await sharesOf(AGENT)).toEqual([guest.personalSpaceId]);
    await getDbRow(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, guest.personalSpaceId))!,
    );
  });

  it("keeps the per-space settings across a deactivate / reactivate round trip", async () => {
    // The reason the row is kept rather than deleted: a space that switches a
    // package off for a week must not lose the model it chose for it.
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);
    expect((await activate(owner(teamId), teamId)).status).toBe(201);
    await db
      .update(spacePackages)
      .set({ modelId: "gpt-test" })
      .where(and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId)));

    const off = await app.request(`/api/spaces/${teamId}/packages/${AGENT}`, {
      method: "DELETE",
      headers: owner(teamId),
    });
    expect(off.status, await off.clone().text()).toBe(204);
    expect(
      (
        await getDbRow(
          spacePackages,
          and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId))!,
        )
      ).modelId,
    ).toBe("gpt-test");

    // 201: this call turned the package back on. The body is the row the
    // transaction wrote, and it still carries the model the space chose.
    const back = await activate(owner(teamId), teamId);
    expect(back.status, await back.clone().text()).toBe(201);
    expect(await back.json()).toMatchObject({ enabled: true, modelId: "gpt-test" });

    // A SECOND activation changes nothing, and says so with 200.
    const again = await activate(owner(teamId), teamId);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ enabled: true, modelId: "gpt-test" });
  });

  it("takes the readability away from the space when the share is revoked", async () => {
    const teamBuilder = await principal({
      orgRole: "member",
      space: { id: teamId, preset: "builder" },
    });
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);
    expect((await activate(teamBuilder.headers(teamId), teamId)).status).toBe(201);
    const readable = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: teamMember.headers(teamId),
    });
    expect(readable.status, await readable.clone().text()).toBe(200);

    expect((await revokeShare(owner(), AGENT, teamId)).status).toBe(204);

    await expectProblem(
      await app.request(`/api/packages/agents/${AGENT}`, { headers: teamMember.headers(teamId) }),
      404,
    );
    // The revoke is the ONE path that deletes a placement row: without the
    // offer there is nothing placing the package here at all.
    await assertDbMissing(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, teamId))!,
    );
  });
});

describe("sharing with a team space", () => {
  // The SHARER must reach the destination: `packageAccessSpaces` is what the
  // route looks the target up in, so a builder confined to the home cannot
  // offer the package to a closed space they are not in (404, tested below).
  // The organization owner reaches every team space, so they are the sharer here.
  it("shows the package to that space's members and to nobody else", async () => {
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);

    const lib = await library(teamMember.headers(teamId));
    expect(
      placementIn(
        lib.packages.agent?.find((e) => e.id === AGENT),
        teamId,
      ),
    ).toMatchObject({
      via: "shared",
      state: "none",
    });
    const detail = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: teamMember.headers(teamId),
    });
    expect(detail.status, await detail.clone().text()).toBe(200);

    // The recipient of nothing still sees nothing.
    const other = await library(recipient.headers());
    expect(other.packages.agent ?? []).toHaveLength(0);
  });

  it("refuses a destination the SHARER cannot reach (404)", async () => {
    await expectProblem(await shareWithSpace(author.headers(homeId), AGENT, teamId), 404);
  });

  it("reaches the space's per-type index page once the space takes it up", async () => {
    await shareWithSpace(owner(), AGENT, teamId);
    const indexIds = async () => {
      const res = await app.request("/api/packages/agents", {
        headers: teamMember.headers(teamId),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { data: { id: string }[] }).data.map((entry) => entry.id);
    };

    // The offer alone places the agent in the team space; it does not switch it
    // on there, and the index is the set the space can launch.
    expect(await indexIds()).not.toContain(AGENT);
    expect((await takeUpOffer(owner(), AGENT, teamId)).status).toBe(201);
    expect(await indexIds()).toContain(AGENT);
  });
});

describe("nothing leaks about a personal space", () => {
  it("refuses a `space` target that is another member's personal space (404)", async () => {
    // The sharer knows the id here only because the fixture told them; over
    // the API it is never emitted. It must still be untargetable.
    await expectProblem(
      await shareWithSpace(author.headers(homeId), AGENT, recipient.personalSpaceId),
      404,
    );
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
  });

  it("lets an org admin READ a package homed in a personal space without reaching that space", async () => {
    await seedPackage({
      id: PRIVATE_AGENT,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: author.personalSpaceId,
      createdBy: author.userId,
      draftManifest: { name: PRIVATE_AGENT, version: "0.1.0", type: "agent" },
      draftContent: "Private.",
    });
    // Offering it to a person needs something to pin, like every other offer
    // in this suite.
    await publish(PRIVATE_AGENT, "0.1.0");
    // The admin cannot see it at all to begin with.
    await expectProblem(
      await app.request(`/api/packages/agents/${PRIVATE_AGENT}`, { headers: admin.headers() }),
      404,
    );

    expect(
      (await shareWithUser(author.headers(author.personalSpaceId), PRIVATE_AGENT, admin.userId))
        .status,
    ).toBe(200);

    const res = await app.request(`/api/packages/agents/${PRIVATE_AGENT}`, {
      headers: admin.headers(),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const detail = (await res.json()) as {
      home_space_id: string | null;
      home_writable: boolean;
      home_shareable: boolean;
    };
    // Readable BECAUSE it was shared with them; the home stays invisible, and
    // with it every authority over the package (RBAC spec §3.6, §6.9).
    expect(detail.home_space_id).toBeNull();
    expect(detail.home_writable).toBe(false);
    expect(detail.home_shareable).toBe(false);

    // And the admin cannot re-share what they were merely given.
    await expectProblem(
      await shareWithUser(admin.headers(), PRIVATE_AGENT, teamMember.userId),
      403,
    );
  });
});

describe("sharing a package does not displace its HOME", () => {
  // The regression: reading installations and shares as ONE set made a single
  // share turn the author's own package into a 404 on every route that asks
  // "may this caller see this id" — its versions, a fork of it, activating it
  // somewhere else. The HOME is a placement of its own and a read grant with
  // it (`placementGrantsRead`), so giving a package away adds an audience and
  // takes nothing back.
  beforeEach(async () => {
    // `SKILL` is homed in `homeId` and installed nowhere, so the share is the
    // only OTHER placement — the exact shape the regression needed.
    expect((await shareWithUser(owner(), SKILL, recipient.userId)).status).toBe(200);
  });

  it("keeps its version list readable from the home", async () => {
    const res = await app.request(`/api/packages/skills/${SKILL}/versions`, { headers: owner() });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("keeps it installable into a team space from the home", async () => {
    const res = await app.request(`/api/spaces/${teamId}/packages`, {
      method: "POST",
      headers: { ...owner(), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: SKILL }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("keeps it reachable by the fork route", async () => {
    // `forkPackage` refuses a source the organization already owns, so the
    // green path is a 400 and not a 201. What is asserted is that the refusal
    // is that one, and NOT the reachability 404 that runs before it.
    const res = await app.request(`/api/packages/${SKILL}/fork`, {
      method: "POST",
      headers: { ...owner(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "helper-copy" }),
    });
    expect(res.status, await res.clone().text()).not.toBe(404);
  });

  it("still hides it from a member who was not the recipient", async () => {
    await expectProblem(
      await app.request(`/api/packages/skills/${SKILL}`, { headers: teamMember.headers(teamId) }),
      404,
    );
  });
});

describe("copy control — `org_settings.restrict_package_copy`", () => {
  /**
   * The fork source is a SYSTEM package: `forkPackage` refuses a source the org
   * already owns ("You already own this package"), so an org-owned package can
   * never be forked WITHIN one organization at all. A system package is also
   * EXEMPT from the key, which is what these tests pin — the platform ships it
   * readable in every space of every organization, so there is no space that
   * owns it for a setting about copying out of one to protect.
   *
   * The key's live effect is therefore on DOWNLOAD (asserted below on the
   * organization's own agent) and on a CROSS-organization fork, which needs two
   * organizations and is out of this suite's fixture.
   */
  const SYSTEM_AGENT = "@appstrate/sys-worker";
  const SYSTEM_SKILL = "@appstrate/sys-helper";

  /** Fork into the caller's own personal space, where they hold `admin`. */
  const fork = (who: Principal, packageId = SYSTEM_AGENT) =>
    app.request(`/api/packages/${packageId}/fork`, {
      method: "POST",
      headers: { ...who.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: `copy-${who.userId.slice(-6).toLowerCase()}` }),
    });

  const download = (who: Principal, packageId: string, spaceId?: string) =>
    app.request(`/api/packages/${packageId}/0.1.0/download`, { headers: who.headers(spaceId) });

  /**
   * The THIRD copy door, and the widest: the whole agent plus every
   * dependency's files. Deliberately the PUBLISHED archive — `source=draft` has
   * a gate of its own (write authority over the agent), so a refusal on it
   * would be that rule and not the copy key this block is about.
   */
  const bundle = (who: Principal, packageId = AGENT, spaceId = homeId) =>
    app.request(`/api/agents/${packageId}/bundle`, { headers: who.headers(spaceId) });

  /** An on-screen read of the package's files — deliberately NOT a copy door. */
  const fileList = (who: Principal, packageId = AGENT, spaceId = homeId) =>
    app.request(`/api/packages/${packageId}/files`, { headers: who.headers(spaceId) });

  /** A published system package with its archive in storage — what a fork copies. */
  async function seedSystem(id: string, type: "agent" | "skill"): Promise<void> {
    const manifest = {
      name: id,
      version: "0.1.0",
      type,
      schema_version: "0.1",
      description: "A system package",
    };
    const content =
      type === "skill" ? "---\nname: sys-helper\ndescription: d\n---\n\nbody" : "Do it.";
    await seedPackage({
      id,
      orgId: null,
      source: "system",
      type,
      draftManifest: manifest,
      draftContent: content,
    });
    const zip = buildMinimalZip(manifest, content, type === "skill" ? "SKILL.md" : "prompt.md");
    await uploadPackageZip(id, "0.1.0", zip);
    const row = await seedPackageVersion({
      packageId: id,
      version: "0.1.0",
      manifest,
      integrity: computeIntegrity(new Uint8Array(zip)),
      artifactSize: zip.byteLength,
    });
    await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: row.id });
  }

  beforeEach(async () => {
    await seedSystem(SYSTEM_AGENT, "agent");
    await seedSystem(SYSTEM_SKILL, "skill");
  });

  it("off (the default): a viewer forks a system agent into their own space", async () => {
    // Documented SOTA behaviour: reading implies copying, as in Notion, Drive
    // and Figma. The viewer holds `agents:write` in their OWN space (they are
    // its admin), which is what the fork's destination asks for.
    const res = await fork(viewer);
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("on: a SYSTEM package is exempt — a viewer, an operator and an admin all fork it", async () => {
    await setRestrictCopy(true);
    for (const who of [viewer, teamMember, admin]) {
      const res = await fork(who);
      expect(res.status, await res.clone().text()).toBe(201);
    }
  });

  it("on: a SYSTEM version's download stays open, agent and skill alike", async () => {
    await setRestrictCopy(true);
    expect((await download(viewer, SYSTEM_AGENT)).status).toBe(200);
    expect((await download(viewer, SYSTEM_SKILL)).status).toBe(200);
  });

  it("on: the home's builder downloads an org package it may share, a viewer may not", async () => {
    await setRestrictCopy(true);
    // The point is that the COPY gate does not fire for this caller: whatever
    // the download answers, it is not a 403.
    expect((await download(author, AGENT, homeId)).status).not.toBe(403);
    await expectProblem(await download(viewer, AGENT, homeId), 403, {
      code: "package_copy_restricted",
    });
    // Off again, and the viewer gets the same non-403 the builder got.
    await setRestrictCopy(false);
    expect((await download(viewer, AGENT, homeId)).status).not.toBe(403);
  });

  it("on: a SKILL of the organization is exempt — the CLI's skills sync copies by design", async () => {
    // The org's own skill, not the system one: a system package is exempt for a
    // reason of its own, so asserting the skill exemption on one would pass
    // whatever the type rule did.
    await setRestrictCopy(true);
    expect((await download(viewer, SKILL, homeId)).status).not.toBe(403);
    // The control, same caller, same space, same toggle: an AGENT is refused.
    await expectProblem(await download(viewer, AGENT, homeId), 403, {
      code: "package_copy_restricted",
    });
  });

  it("off: `/bundle` hands the agent to any reader of the space it is installed in", async () => {
    const res = await bundle(viewer);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("on: `/bundle` needs `agents:share` in the home — a viewer is refused", async () => {
    await setRestrictCopy(true);
    // The widest copy door of the three, and the one that used to be gated on
    // read + installed alone: without it a restricted organization's `download`
    // refusal was one `appstrate run --local` away from being pointless.
    await expectProblem(await bundle(viewer), 403, { code: "package_copy_restricted" });
    // The home's builder holds it, so the archive is served.
    const allowed = await bundle(author);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    // Off again, and the viewer gets what the builder got.
    await setRestrictCopy(false);
    expect((await bundle(viewer)).status).toBe(200);
  });

  it("on: reading the package's FILES stays open — a screen is not a copy", async () => {
    await setRestrictCopy(true);
    // The negative control of the whole key: it narrows the routes that hand
    // over a package, not the ones that show it. A viewer who may read the
    // agent still reads its file tree.
    const listed = await fileList(viewer);
    expect(listed.status, await listed.clone().text()).toBe(200);
    // …while the same caller, same space, same toggle, cannot take it away.
    await expectProblem(await bundle(viewer), 403, { code: "package_copy_restricted" });
  });

  it("on: a run is unaffected — a bundle is assembled server-side, never copied", async () => {
    await setRestrictCopy(true);
    expect((await shareWithUser(author.headers(homeId), AGENT, viewer.userId)).status).toBe(200);
    expect((await takeUpOffer(viewer.headers(), AGENT)).status).toBe(201);
    const launched = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...viewer.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(launched.status, await launched.clone().text()).toBe(201);
    await waitForRunPipelineSettled();
  });
});

/**
 * The lock, driven by hand (`services/space-packages.ts` → `sharedWith`).
 *
 * The in-process test above asserts the sequential property: after a committed
 * revoke, the install finds no offer. It cannot see the RACE, and the race is
 * what the lock is for — a revoke whose DELETE has landed but not committed is
 * invisible to a plain SELECT under READ COMMITTED, so without the lock the
 * install sails past it and commits an installation nothing backs. That state
 * is unreachable through any route afterwards: nothing
 * uninstalls it, and the recipient runs the package with their own credentials.
 *
 * Reproducing it needs TWO transactions held open at once, i.e. two
 * connections, i.e. a real PostgreSQL — PGlite is a single-process embedded
 * engine, so under `TEST_TIER=0` there is no interleaving to observe and this
 * block skips with that as its reason (`test/helpers/tier.ts`).
 */
describeRequiresPostgres("a revoke racing an install (needs a real PostgreSQL)", () => {
  beforeEach(async () => {
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    // NOT installed: the fixture must leave `space_packages` empty for this
    // pair, so the revoke's second DELETE takes no row lock of its own and the
    // install's INSERT has nothing to conflict on. Otherwise the install would
    // block on the unique index rather than on the share row, and the test
    // would pass with or without the lock under test.
    await assertDbMissing(
      spacePackages,
      and(
        eq(spacePackages.packageId, AGENT),
        eq(spacePackages.spaceId, recipient.personalSpaceId),
      )!,
    );
  });

  it("makes the install wait, then refuse — never an installation with no offer", async () => {
    let commitRevoke!: () => void;
    const gate = new Promise<void>((resolve) => {
      commitRevoke = resolve;
    });

    // T1 — the revoke's two deletes, then HELD OPEN. This is
    // `revokePackageShare`'s body, inlined so the transaction can be paused
    // mid-flight; the service commits it in one go and gives no seam.
    const revoking = db.transaction(async (tx) => {
      await tx
        .delete(packageShares)
        .where(
          and(
            eq(packageShares.packageId, AGENT),
            eq(packageShares.spaceId, recipient.personalSpaceId),
          ),
        );
      await tx
        .delete(spacePackages)
        .where(
          and(
            eq(spacePackages.packageId, AGENT),
            eq(spacePackages.spaceId, recipient.personalSpaceId),
          ),
        );
      await gate;
    });
    await Bun.sleep(150);

    // T2 — the install. `SELECT … FOR UPDATE` on the share row blocks on T1's
    // uncommitted delete; without the lock this read sees the row (T1 has not
    // committed) and the install commits a `space_packages` row nothing backs.
    const activating = activatePackage(
      { orgId: ctx.orgId, spaceId: recipient.personalSpaceId },
      AGENT,
    );
    let settled = false;
    void activating.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(300);
    // Still waiting on the lock — the observable half of the fix.
    expect(settled, "the install must block until the revoke commits").toBe(false);

    commitRevoke();
    await revoking;

    // The lock released onto a deleted row: READ COMMITTED re-evaluates and the
    // offer is gone, so the install refuses.
    await expect(activating).rejects.toThrow();
    await assertDbMissing(packageShares, eq(packageShares.packageId, AGENT));
    await assertDbMissing(
      spacePackages,
      and(
        eq(spacePackages.packageId, AGENT),
        eq(spacePackages.spaceId, recipient.personalSpaceId),
      )!,
    );
  });
});

describe("the table has no other reader", () => {
  it("names `package_shares` only in the share service, the placement loaders and the library", async () => {
    // The two-table split is only worth anything while this stays true: a
    // reader on an execution path would run a package nobody consented to.
    const proc = Bun.spawnSync(["grep", "-rl", "packageShares", "apps/api/src", "packages/db/src"]);
    const files = new TextDecoder().decode(proc.stdout).split("\n").filter(Boolean).sort();
    // The share ROUTES reach the table through `services/package-shares.ts`,
    // and every rehome writes its offers through
    // `services/package-placement.ts`; these are every file that names it. The
    // ones that read it DIRECTLY read it as PLACEMENT, never as permission to
    // run: `package-placement.ts` states the rule in SQL,
    // `package-activation.ts` conjoins that rule so a row without a placement
    // behind it counts for nothing, `package-library.ts` projects the share
    // half per space (a listing), and the rest join it to ask the placement
    // question of one package. `integration-service.ts` joins it for that
    // reason and no other: the Integrations page's own two routes narrow on
    // `placementReadFilter`, which needs this LEFT JOIN or an offered
    // integration drops out of its own page.
    expect(files).toEqual([
      "apps/api/src/lib/package-access.ts",
      "apps/api/src/services/integration-connections.ts",
      "apps/api/src/services/integration-service.ts",
      "apps/api/src/services/package-activation.ts",
      "apps/api/src/services/package-items/crud.ts",
      "apps/api/src/services/package-library.ts",
      "apps/api/src/services/package-placement.ts",
      "apps/api/src/services/package-shares.ts",
      "apps/api/src/services/space-packages.ts",
      "packages/db/src/schema/packages.ts",
    ]);
  });
});
