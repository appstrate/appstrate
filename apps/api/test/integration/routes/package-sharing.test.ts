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
 *      recipient and never runnable: the run route stays 404 until they accept,
 *      the accept PINS the version so a later publish does not change what they
 *      execute, and revoking removes the installation with the offer.
 *   3. NOTHING LEAKS. Another member's personal space is not targetable by id,
 *      the sharer never sees such an id back, and an organization admin who was
 *      shared a package homed in somebody's personal space reads it without
 *      thereby reaching that space.
 *
 * A fourth section covers the copy key (`org_settings.restrict_package_copy`),
 * which exists because `share` protects the link and not the content.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  notifications,
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
  seedEndUser,
  seedInstalledPackage,
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
import { buildMinimalZip, uploadPackageZip } from "../../../src/services/package-storage.ts";
import { acceptSharedPackage } from "../../../src/services/space-packages.ts";
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

const acceptShare = (headers: Headers, packageId: string) =>
  app.request(`/api/packages/${packageId}/shares/accept`, { method: "POST", headers });

/** `GET /api/library`, org-scoped (no space header). */
async function library(headers: Headers): Promise<{
  packages: Record<string, { id: string; update_available: boolean }[]>;
  shared: {
    id: string;
    personal: boolean;
    space_id: string;
    shared_by: { user_id: string; name: string } | null;
  }[];
}> {
  const res = await app.request("/api/library", {
    headers: { Cookie: headers.Cookie!, "X-Org-Id": headers["X-Org-Id"]! },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as never;
}

/** Publish a version and move the `latest` dist-tag onto it. */
async function publish(packageId: string, version: string): Promise<number> {
  const row = await seedPackageVersion({
    packageId,
    version,
    manifest: { name: packageId, version, type: "agent" },
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

/** The version pinned by `spaceId`'s installation, or `null` when unpinned. */
async function pinOf(spaceId: string, packageId: string): Promise<number | null> {
  const row = await getDbRow(
    spacePackages,
    and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId))!,
  );
  return row.versionId;
}

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
  await seedInstalledPackage(homeId, AGENT);
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
      uninstalled: false,
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
    await publish(AGENT, "0.1.0");
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
  });

  /** The launch route, from the recipient's own space. `version=draft` needs no artifact. */
  const runAsRecipient = (who: Principal) =>
    app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...who.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  it("shows the offer in the recipient's library and makes the package readable", async () => {
    const lib = await library(recipient.headers());
    const offer = lib.shared.find((entry) => entry.id === AGENT);
    expect(offer).toBeDefined();
    expect(offer!.personal).toBe(true);
    expect(offer!.space_id).toBe(recipient.personalSpaceId);
    expect(offer!.shared_by?.user_id).toBe(author.userId);

    const detail = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: recipient.headers(),
    });
    expect(detail.status, await detail.clone().text()).toBe(200);
  });

  it("refuses the run until the recipient accepts", async () => {
    await expectProblem(await runAsRecipient(recipient), 404);

    const accepted = await acceptShare(recipient.headers(), AGENT);
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    const launched = await runAsRecipient(recipient);
    expect(launched.status, await launched.clone().text()).toBe(201);
    await waitForRunPipelineSettled();
  });

  it("pins `latest` at accept, and a later publish does not move the pin", async () => {
    const accepted = await acceptShare(recipient.headers(), AGENT);
    const body = (await accepted.json()) as { version_id: number };
    expect(await pinOf(recipient.personalSpaceId, AGENT)).toBe(body.version_id);

    const v2 = await publish(AGENT, "0.2.0");
    expect(v2).not.toBe(body.version_id);
    // THE invariant: the author publishing does not change what the recipient
    // executes with the recipient's own credentials.
    expect(await pinOf(recipient.personalSpaceId, AGENT)).toBe(body.version_id);

    // Re-accepting is the update: same route, same act, now on v2.
    const again = await acceptShare(recipient.headers(), AGENT);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await pinOf(recipient.personalSpaceId, AGENT)).toBe(v2);
  });

  it("reports the pending update in the recipient's library", async () => {
    await acceptShare(recipient.headers(), AGENT);
    expect(
      (await library(recipient.headers())).packages.agent?.find((p) => p.id === AGENT)
        ?.update_available,
    ).toBe(false);
    await publish(AGENT, "0.2.0");
    expect(
      (await library(recipient.headers())).packages.agent?.find((p) => p.id === AGENT)
        ?.update_available,
    ).toBe(true);
  });

  it("leaves the shared section once the offer is accepted", async () => {
    await acceptShare(recipient.headers(), AGENT);
    const lib = await library(recipient.headers());
    expect(lib.shared.find((entry) => entry.id === AGENT)).toBeUndefined();
    expect(lib.packages.agent?.some((entry) => entry.id === AGENT)).toBe(true);
  });

  it("revokes the offer AND the installation behind it", async () => {
    await acceptShare(recipient.headers(), AGENT);
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

  it("refuses to accept an offer nobody made (404)", async () => {
    await expectProblem(await acceptShare(teamMember.headers(), AGENT), 404);
  });

  it("refuses to accept for a principal that HAS no personal space (404)", async () => {
    // An API key and an end-user have nothing to accept INTO — the route reads
    // `callerPersonalOwnerId`, which is `null` for both — and neither may be
    // the reason a space gets created for the key's creator behind their back.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: homeId,
      createdBy: ctx.user.id,
      scopes: ["agents:read", "agents:configure"],
    });
    await expectProblem(
      await app.request(`/api/packages/${AGENT}/shares/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.rawKey}` },
      }),
      404,
    );

    const endUser = await seedEndUser({
      orgId: ctx.orgId,
      spaceId: homeId,
      externalId: "ext-share-accept",
    });
    await expectProblem(
      await app.request(`/api/packages/${AGENT}/shares/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id },
      }),
      404,
    );
  });

  it("keeps every route that needs the INSTALLATION shut until the accept", async () => {
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

    expect((await acceptShare(recipient.headers(), AGENT)).status).toBe(200);
    const created = await schedule();
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it("lets a GUEST accept — the `operator` preset holds no install grant", async () => {
    // The acceptance criterion of the whole lot, as the plan words it: "an
    // external invited as a guest sees EXACTLY ONE agent after the share, and
    // nothing else in the library". So the assertion is on the library's shape
    // and not only on the pin — a guest who could see a second package would
    // pass a `pinOf` check just as well.
    expect((await shareWithUser(author.headers(homeId), AGENT, guest.userId)).status).toBe(200);

    const before = await library(guest.headers());
    expect(before.shared.map((entry) => entry.id)).toEqual([AGENT]);
    // Offered is not installed: every type group is empty, the system-package
    // groups included (the fixture seeds none).
    for (const [type, group] of Object.entries(before.packages)) {
      expect(group, `library.packages.${type} before the accept`).toEqual([]);
    }

    const accepted = await acceptShare(guest.headers(), AGENT);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await pinOf(guest.personalSpaceId, AGENT)).not.toBeNull();

    const after = await library(guest.headers());
    expect(after.shared).toEqual([]);
    expect(after.packages.agent?.map((entry) => entry.id)).toEqual([AGENT]);
    expect(Object.values(after.packages).flat()).toHaveLength(1);
  });

  it("checks the offer INSIDE the transaction that installs — a revoked share cannot be accepted", async () => {
    // The check moved out of the route and next to the insert it authorizes, so
    // that a revoke committing between the two cannot leave an installation the
    // share no longer backs. Racing the two is not reproducible in-process;
    // what is asserted is the property the single transaction guarantees —
    // after the revoke, the accept finds no offer and writes nothing.
    expect((await revokeShare(author.headers(homeId), AGENT, recipient.userId)).status).toBe(204);
    await expectProblem(await acceptShare(recipient.headers(), AGENT), 404);
    await assertDbMissing(
      spacePackages,
      and(
        eq(spacePackages.packageId, AGENT),
        eq(spacePackages.spaceId, recipient.personalSpaceId),
      )!,
    );
  });

  it("refuses the normal install route into a personal space without an offer", async () => {
    const res = await app.request(`/api/spaces/${teamMember.personalSpaceId}/packages`, {
      method: "POST",
      headers: { ...teamMember.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: AGENT }),
    });
    await expectProblem(res, 404);
  });
});

describe("a share with nothing published", () => {
  it("answers 409 rather than installing something that follows `latest`", async () => {
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    await expectProblem(await acceptShare(recipient.headers(), AGENT), 409, {
      code: "package_has_no_version",
    });
  });
});

describe("sharing with a team space", () => {
  // The SHARER must reach the destination: `packageAccessSpaces` is what the
  // route looks the target up in, so a builder confined to the home cannot
  // offer the package to a closed space they are not in (404, tested below).
  // The organization owner reaches every team space, so they are the sharer here.
  it("shows the package to that space's members and to nobody else", async () => {
    expect((await shareWithSpace(owner(), AGENT, teamId)).status).toBe(200);

    const lib = await library(teamMember.headers());
    expect(lib.shared.find((entry) => entry.id === AGENT)?.personal).toBe(false);
    const detail = await app.request(`/api/packages/agents/${AGENT}`, {
      headers: teamMember.headers(teamId),
    });
    expect(detail.status, await detail.clone().text()).toBe(200);

    // The recipient of nothing still sees nothing.
    const other = await library(recipient.headers());
    expect(other.shared).toHaveLength(0);
    expect(other.packages.agent ?? []).toHaveLength(0);
  });

  it("refuses a destination the SHARER cannot reach (404)", async () => {
    await expectProblem(await shareWithSpace(author.headers(homeId), AGENT, teamId), 404);
  });

  it("lists it on the space's per-type index page", async () => {
    await shareWithSpace(owner(), AGENT, teamId);
    const res = await app.request("/api/packages/agents", { headers: teamMember.headers(teamId) });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((entry) => entry.id)).toContain(AGENT);
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

describe("a NULL-home package stays the organization's when it is shared", () => {
  // The org-catalogue exception (`lib/package-access.ts` →
  // `assertPackageIsReachable`) is about INSTALLATIONS, and only about them:
  // offering a catalogue package to somebody must not take it away from the
  // organization that owns it. Reading installations and shares as ONE set made
  // one share turn the owner's own package into a 404 on every route that asks
  // "may this caller see this id" — its versions, a fork of it, installing it.
  beforeEach(async () => {
    // `SKILL` is homed in `homeId` and installed nowhere, so moving it to the
    // catalogue leaves the share as its only placement — the exact shape.
    await db.update(packages).set({ homeSpaceId: null }).where(eq(packages.id, SKILL));
    expect((await shareWithUser(owner(), SKILL, recipient.userId)).status).toBe(200);
  });

  it("keeps its version list readable for the owner", async () => {
    const res = await app.request(`/api/packages/skills/${SKILL}/versions`, { headers: owner() });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("keeps it installable into a team space by the owner", async () => {
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
    // is no longer the reachability 404 that runs BEFORE it.
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
   * owns it for a setting about copying out of one to protect, and reading its
   * NULL home as the organization catalogue turned the key into "only owners
   * and admins may install the shipped catalogue".
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
   * dependency's files. `source=draft` needs no stored artifact, so a refusal
   * here is the copy gate and never a missing archive.
   */
  const bundle = (who: Principal, packageId = AGENT, spaceId = homeId) =>
    app.request(`/api/agents/${packageId}/bundle?source=draft`, { headers: who.headers(spaceId) });

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
    await publish(AGENT, "0.1.0");
    // No archive in storage for this one — the point is that the COPY gate does
    // not fire, so the refusal is the missing artifact and not a 403.
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
    await publish(AGENT, "0.1.0");
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
    await publish(AGENT, "0.1.0");
    expect((await shareWithUser(author.headers(homeId), AGENT, viewer.userId)).status).toBe(200);
    await acceptShare(viewer.headers(), AGENT);
    const launched = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
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
 * revoke, the accept finds no offer. It cannot see the RACE, and the race is
 * what the lock is for — a revoke whose DELETE has landed but not committed
 * used to be invisible to the accept's plain SELECT under READ COMMITTED, so
 * the accept sailed past it and committed an installation the share no longer
 * backed. That state is unreachable through any route afterwards: nothing
 * uninstalls it, and the recipient runs the package with their own credentials.
 *
 * Reproducing it needs TWO transactions held open at once, i.e. two
 * connections, i.e. a real PostgreSQL — PGlite is a single-process embedded
 * engine, so under `TEST_TIER=0` there is no interleaving to observe and this
 * block skips with that as its reason (`test/helpers/tier.ts`).
 */
describeRequiresPostgres("a revoke racing an accept (needs a real PostgreSQL)", () => {
  beforeEach(async () => {
    await publish(AGENT, "0.1.0");
    expect((await shareWithUser(author.headers(homeId), AGENT, recipient.userId)).status).toBe(200);
    // NOT accepted: the fixture must leave `space_packages` empty for this
    // pair, so the revoke's second DELETE takes no row lock of its own and the
    // accept's INSERT has nothing to conflict on. Otherwise the accept would
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

  it("makes the accept wait, then refuse — never an installation with no offer", async () => {
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

    // T2 — the accept. `SELECT … FOR UPDATE` on the share row blocks on T1's
    // uncommitted delete; without the lock this read sees the row (T1 has not
    // committed) and the accept commits an installation.
    const accepting = acceptSharedPackage(
      { orgId: ctx.orgId, spaceId: recipient.personalSpaceId },
      AGENT,
    );
    let settled = false;
    void accepting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(300);
    // Still waiting on the lock — the observable half of the fix.
    expect(settled, "the accept must block until the revoke commits").toBe(false);

    commitRevoke();
    await revoking;

    // The lock released onto a deleted row: READ COMMITTED re-evaluates and the
    // offer is gone, so the accept refuses.
    await expect(accepting).rejects.toThrow();
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
    // The share ROUTES and the library reach the table through
    // `services/package-shares.ts`; these five are every file that names it.
    expect(files).toEqual([
      "apps/api/src/lib/package-access.ts",
      "apps/api/src/services/package-items/crud.ts",
      "apps/api/src/services/package-shares.ts",
      "apps/api/src/services/space-packages.ts",
      "packages/db/src/schema/packages.ts",
    ]);
  });
});
