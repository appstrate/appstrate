// SPDX-License-Identifier: Apache-2.0

/**
 * The home space over HTTP: who edits a package installed in two spaces, and
 * what moving its home does to that answer (RBAC spec §6.9).
 *
 * The fixture is the case the retired rule got wrong — it demanded the
 * permission in each of a package's installations: one skill, homed in Alpha,
 * ALSO installed in Beta. Alpha's builder must keep it; Beta's builder must
 * never gain it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { packages, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem, getDbRow } from "../../helpers/assertions.ts";
import { expectRejectedField } from "../../helpers/body-validation.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
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
import {
  setPermissionDenialHandler,
  type PermissionDenialContext,
} from "@appstrate/core/permissions";

const app = getTestApp();

const ID = "@homes/shared";
/** An agent homed in Alpha, used by the execution-gate assertions only. */
const AGENT = "@homes/worker";
const CONTENT = "---\nname: shared\ndescription: A shared skill\n---\n\nInstructions";
const MANIFEST = { name: ID, version: "0.1.0", type: "skill", description: "A shared skill" };

let ctx: TestContext;
/** The home — `ctx`'s default space. */
let alphaId: string;
/** A second space the package is installed in, and which governs nothing. */
let betaId: string;
/** A third space, reachable by the owner, where nothing is installed. */
let gammaId: string;
/** A space neither builder can reach. */
let hiddenId: string;

/** Builder in Alpha only. */
let alpha: Record<string, string>;
/** Builder in Beta only. */
let beta: Record<string, string>;

/** Headers for the org owner, acting in Alpha. */
const owner = () => ({
  Cookie: ctx.cookie,
  "X-Org-Id": ctx.orgId,
  "X-Space-Id": alphaId,
});

/** A session pinned to one space, holding one preset there and nothing elsewhere. */
async function memberIn(
  spaceId: string,
  presetRole: "builder" | "viewer",
): Promise<Record<string, string>> {
  const user = await createTestUser();
  await addOrgMember(ctx.orgId, user.id, "guest");
  await seedSpaceMember({ spaceId, userId: user.id, presetRole });
  return { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": spaceId };
}

/** A builder session pinned to one space. */
const builderIn = (spaceId: string) => memberIn(spaceId, "builder");

/** A draft save — the plainest write the home has to authorize. */
async function editSkill(headers: Record<string, string>) {
  const row = await getDbRow(packages, eq(packages.id, ID));
  return app.request(`/api/packages/skills/${ID}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `${CONTENT} edited`, lock_version: row.lockVersion }),
  });
}

const move = (headers: Record<string, string>, homeSpaceId: string | null) =>
  app.request(`/api/packages/${ID}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ home_space_id: homeSpaceId }),
  });

const homeOf = async () => (await getDbRow(packages, eq(packages.id, ID))).homeSpaceId;

/** Does the detail report the draft as ahead of its latest published version? */
async function unarchivedChanges(): Promise<boolean> {
  const res = await app.request(`/api/packages/skills/${ID}`, { headers: owner() });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { has_unarchived_changes: boolean }).has_unarchived_changes;
}

// One run actually launches here (the positive control of the execution gate),
// so the orchestrator is replaced with the inert one rather than reaching Docker.
beforeAll(() => {
  _setOrchestratorForTesting(createFakeOrchestrator());
});

afterAll(() => {
  _setOrchestratorForTesting(null);
});

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "homes" });
  alphaId = ctx.defaultSpaceId;
  betaId = (await seedSpace({ orgId: ctx.orgId, name: "Beta", visibility: "closed" })).id;
  gammaId = (await seedSpace({ orgId: ctx.orgId, name: "Gamma", visibility: "closed" })).id;
  hiddenId = (await seedSpace({ orgId: ctx.orgId, name: "Hidden", visibility: "private" })).id;

  await seedPackage({
    id: ID,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: alphaId,
    createdBy: ctx.user.id,
    draftManifest: MANIFEST,
    draftContent: CONTENT,
  });
  await seedInstalledPackage(alphaId, ID);
  await seedInstalledPackage(betaId, ID);

  alpha = await builderIn(alphaId);
  beta = await builderIn(betaId);
});

/** The package's own detail, from whatever space the headers name. */
const detailOf = (headers: Record<string, string>) =>
  app.request(`/api/packages/skills/${ID}`, { headers });

/** The file explorer index — the third read gate the home has to open. */
const filesOf = (headers: Record<string, string>) =>
  app.request(`/api/packages/${ID}/files`, { headers });

/** Ids on the skills INDEX page — `GET /api/packages/skills`, a per-space read. */
async function skillIndexIds(headers: Record<string, string>): Promise<string[]> {
  const res = await app.request("/api/packages/skills", { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((pkg) => pkg.id);
}

/** Ids of the skills `GET /api/library` shows this caller (an org-scoped read). */
async function librarySkillIds(headers: Record<string, string>): Promise<string[]> {
  const res = await app.request("/api/library", {
    headers: { Cookie: headers.Cookie!, "X-Org-Id": headers["X-Org-Id"]! },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { packages: { skill: { id: string }[] } };
  return body.packages.skill.map((pkg) => pkg.id);
}

describe("write authority follows the home", () => {
  it("lets the home's builder edit a package installed elsewhere too", async () => {
    const res = await editSkill(alpha);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("refuses the builder of the other installation", async () => {
    await expectProblem(await editSkill(beta), 403);
    expect((await getDbRow(packages, eq(packages.id, ID))).draftContent).toBe(CONTENT);
  });

  it("ignores the space the request comes from", async () => {
    // Builder in the home, viewer in the space they are browsing. The retired
    // rule asked for the permission wherever the caller happened to be, so this
    // 200 was a 403 — an author locked out of their own package by their own
    // choice of `X-Space-Id`.
    const author = await createTestUser();
    await addOrgMember(ctx.orgId, author.id, "guest");
    await seedSpaceMember({ spaceId: alphaId, userId: author.id, presetRole: "builder" });
    await seedSpaceMember({ spaceId: betaId, userId: author.id, presetRole: "viewer" });

    const res = await editSkill({
      Cookie: author.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": betaId,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("refuses a builder of the other space who only READS the home", async () => {
    // They can see the package — so the answer is 403, not 404 — and still may
    // not touch it, because the permission has to be held in Alpha.
    const outsider = await createTestUser();
    await addOrgMember(ctx.orgId, outsider.id, "guest");
    await seedSpaceMember({ spaceId: alphaId, userId: outsider.id, presetRole: "viewer" });
    await seedSpaceMember({ spaceId: betaId, userId: outsider.id, presetRole: "builder" });
    const headers = { Cookie: outsider.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": betaId };

    expect((await detailOf(headers)).status).toBe(200);
    await expectProblem(await editSkill(headers), 403);
    expect((await getDbRow(packages, eq(packages.id, ID))).draftContent).toBe(CONTENT);
  });

  it("is decided by the previewed persona, not the real caller", async () => {
    // The owner writes this package without a persona (the first assertion of
    // this file). Under a persona that only views the HOME, they must not — the
    // home lookup runs through `effectiveInSpace`, so the preview applies.
    await expectProblem(
      await editSkill({
        ...owner(),
        "X-View-As": `org_role=member; space=${alphaId}; role=preset:viewer`,
      }),
      403,
    );
    expect((await getDbRow(packages, eq(packages.id, ID))).draftContent).toBe(CONTENT);
  });
});

describe("the home is a read grant", () => {
  // Homed in Alpha, installed ONLY in Beta — the shape that was writable and
  // unreadable at the same time: the home authorized the `PUT`, and every read
  // gate asked for an installation the home did not have.
  beforeEach(async () => {
    await db
      .delete(spacePackages)
      .where(and(eq(spacePackages.packageId, ID), eq(spacePackages.spaceId, alphaId)));
  });

  it("opens the detail, the library and the file explorer at home", async () => {
    const detail = await detailOf(alpha);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await librarySkillIds(alpha)).toContain(ID);
    expect((await filesOf(alpha)).status).toBe(200);
    // And the write it already authorized still works, so the two agree.
    expect((await editSkill(alpha)).status).toBe(200);
  });

  it("lists it on its own type's index page at home", async () => {
    // The per-type page is the fourth reader of the placement rule, and the one
    // the SPA's Skills / Agents / MCP servers navigation is built on: a package
    // homed here and installed nowhere used to vanish from it while staying
    // editable — write authority without a way to reach the thing.
    expect(await skillIndexIds(alpha)).toContain(ID);
  });

  it("opens nothing in a space that is neither the home nor an installation", async () => {
    const gamma = await builderIn(gammaId);
    await expectProblem(await detailOf(gamma), 404);
    await expectProblem(await filesOf(gamma), 404);
    expect(await librarySkillIds(gamma)).not.toContain(ID);
    expect(await skillIndexIds(gamma)).not.toContain(ID);
  });

  // The home opens READS. Running is a separate gate — `hasPackageAccess`, an
  // installed `space_packages` row in the space the run happens in — and the
  // two must not be conflated: an agent a space governs but has not installed
  // is not thereby executable there, with that space's credentials.
  describe("and not a right to execute", () => {
    let agentHeaders: Record<string, string>;

    beforeEach(async () => {
      await seedAgent({
        id: AGENT,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        homeSpaceId: alphaId,
        draftManifest: {
          name: AGENT,
          version: "0.1.0",
          type: "agent",
          description: "Homed here, installed nowhere",
        },
        draftContent: "Do the thing.",
      });
      await seedDefaultOrgModel(ctx);
      agentHeaders = { ...owner(), "Content-Type": "application/json" };
    });

    /** The launch route. `version=draft` — the fixture publishes nothing. */
    const runAgent = () =>
      app.request(`/api/agents/${AGENT}/run?version=draft`, {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({}),
      });

    const scheduleAgent = () =>
      app.request(`/api/agents/${AGENT}/schedules`, {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          name: "Nightly",
          cron_expression: "0 3 * * *",
          version_override: "draft",
        }),
      });

    it("refuses a run of an agent homed here but installed nowhere", async () => {
      await expectProblem(await runAgent(), 404, { code: "agent_not_found" });
      // The read gates DO open — so the 404 is the execution rule speaking, not
      // an unreachable package.
      expect(
        (await app.request(`/api/packages/agents/${AGENT}`, { headers: owner() })).status,
      ).toBe(200);

      await seedInstalledPackage(alphaId, AGENT);
      const launched = await runAgent();
      expect(launched.status, await launched.clone().text()).toBe(201);
      await waitForRunPipelineSettled();
    });

    it("refuses a schedule of an agent homed here but installed nowhere", async () => {
      await expectProblem(await scheduleAgent(), 404, { code: "agent_not_found" });

      await seedInstalledPackage(alphaId, AGENT);
      const created = await scheduleAgent();
      expect(created.status, await created.clone().text()).toBe(201);
    });
  });

  it("moves with the home, with no installation in the destination", async () => {
    expect((await move(owner(), gammaId)).status).toBe(200);

    const gamma = await builderIn(gammaId);
    expect((await detailOf(gamma)).status).toBe(200);
    expect(await librarySkillIds(gamma)).toContain(ID);
    expect((await editSkill(gamma)).status).toBe(200);

    // Alpha is now neither home nor installation and loses sight of it.
    await expectProblem(await detailOf(alpha), 404);
    expect(await librarySkillIds(alpha)).not.toContain(ID);
  });
});

describe("PATCH /api/packages/{scope}/{name}", () => {
  it("moves the home, and the authority moves with it", async () => {
    // The owner reaches both ends; a builder of one end alone cannot move it
    // there, which the two refusals below cover.
    const res = await move(owner(), betaId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()) as { home_space_id: string }).toMatchObject({
      home_space_id: betaId,
    });
    expect(await homeOf()).toBe(betaId);

    await expectProblem(await editSkill(alpha), 403);
    expect((await editSkill(beta)).status).toBe(200);
  });

  it("requires write in the destination, not only in the current home", async () => {
    // Reads Beta, cannot author there — so the destination exists for them and
    // the refusal says so.
    const reader = await createTestUser();
    await addOrgMember(ctx.orgId, reader.id, "guest");
    await seedSpaceMember({ spaceId: alphaId, userId: reader.id, presetRole: "builder" });
    await seedSpaceMember({ spaceId: betaId, userId: reader.id, presetRole: "viewer" });
    const headers = { Cookie: reader.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": alphaId };

    await expectProblem(await move(headers, betaId), 403);
    expect(await homeOf()).toBe(alphaId);
  });

  it("refuses a malformed destination id with 400, not the 404 an unreachable one gets", async () => {
    // A retired `app_` spelling resolves to no space. Read as an unreachable
    // destination it answers "Space not found", which sends the caller looking
    // for a permission problem; the body's shape check names the real fault.
    await expectRejectedField(await move(owner(), "app_legacy"), "home_space_id");
    expect(await homeOf()).toBe(alphaId);
  });

  it("answers 404 for a destination the caller cannot reach", async () => {
    // Alpha's builder governs the package; Beta and Hidden do not exist for
    // them, and the answer must not say which of the two is which.
    await expectProblem(await move(alpha, betaId), 404);
    await expectProblem(await move(alpha, hiddenId), 404);
    expect(await homeOf()).toBe(alphaId);
  });

  it("reserves the organization catalog to owners and admins", async () => {
    await expectProblem(await move(alpha, null), 403);
    expect(await homeOf()).toBe(alphaId);

    const res = await move(owner(), null);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await homeOf()).toBeNull();

    // And now nobody but an owner or admin writes it.
    await expectProblem(await editSkill(alpha), 403);
    expect((await editSkill(owner())).status).toBe(200);
  });

  it("audits the permission its own two refusals asked for, and stays silent on the 404", async () => {
    // The route decides these two refusals itself — neither goes through a
    // permission guard — so without an explicit report an operator reading the
    // denial trail sees a 403 that names no permission to grant. The
    // unreachable destination records nothing on purpose: naming a permission
    // "in that space" would confirm the space exists.
    const reader = await createTestUser();
    await addOrgMember(ctx.orgId, reader.id, "guest");
    await seedSpaceMember({ spaceId: alphaId, userId: reader.id, presetRole: "builder" });
    await seedSpaceMember({ spaceId: betaId, userId: reader.id, presetRole: "viewer" });
    const readerHeaders = { Cookie: reader.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": alphaId };

    const denials: string[] = [];
    setPermissionDenialHandler((ctx: PermissionDenialContext) => void denials.push(ctx.required));
    try {
      await expectProblem(await move(alpha, null), 403);
      await expectProblem(await move(readerHeaders, betaId), 403);
      await expectProblem(await move(alpha, hiddenId), 404);
    } finally {
      setPermissionDenialHandler(null);
    }
    expect(denials).toEqual(["skills:write", "skills:write"]);
  });

  it("refuses a caller who does not govern the package at all", async () => {
    await expectProblem(await move(beta, betaId), 403);
    expect(await homeOf()).toBe(alphaId);
  });

  it("leaves a fully-published package published", async () => {
    // `has_unarchived_changes` is `packages.updated_at > latest version's
    // created_at`, i.e. the DRAFT's clock. A move rewrites `home_space_id` and
    // nothing else; stamping `updated_at` here reported an untouched package as
    // dirty and offered its author a version to cut with no changes in it.
    await seedPackageVersion({
      packageId: ID,
      manifest: MANIFEST,
      createdBy: ctx.user.id,
    });
    expect(await unarchivedChanges()).toBe(false);

    const moved = await move(owner(), betaId);
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect((await moved.json()) as { has_unarchived_changes: boolean }).toMatchObject({
      has_unarchived_changes: false,
    });
    expect(await unarchivedChanges()).toBe(false);
  });

  it("rejects an unknown body field rather than dropping it", async () => {
    await expectProblem(
      await app.request(`/api/packages/${ID}`, {
        method: "PATCH",
        headers: { ...owner(), "Content-Type": "application/json" },
        body: JSON.stringify({ home_space_id: betaId, lock_version: 1 }),
      }),
      400,
    );
    expect(await homeOf()).toBe(alphaId);
  });
});

/**
 * ONE wire contract for the home, on every shape that carries it (RBAC spec
 * §6.9): `home_space_id` is the id only when the caller REACHES that space, and
 * `home_writable` is the write verdict, computed by the same predicate the
 * write routes enforce. The SPA derives neither.
 */
describe("the home on the wire", () => {
  type HomeWire = { home_space_id: string | null; home_writable: boolean };

  /** The pair, off the package detail. */
  async function homeWire(headers: Record<string, string>): Promise<HomeWire> {
    const res = await app.request(`/api/packages/skills/${ID}`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as HomeWire;
    return { home_space_id: body.home_space_id, home_writable: body.home_writable };
  }

  /** The same pair, off the library listing — the second of the four shapes. */
  async function libraryHomeWire(headers: Record<string, string>): Promise<HomeWire> {
    const res = await app.request("/api/library", { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      packages: { skill: (HomeWire & { id: string })[] };
    };
    const entry = body.packages.skill.find((p) => p.id === ID);
    expect(entry).toBeDefined();
    return { home_space_id: entry!.home_space_id, home_writable: entry!.home_writable };
  }

  it("gives the home's id and `true` to a builder of the home space", async () => {
    expect(await homeWire(alpha)).toEqual({ home_space_id: alphaId, home_writable: true });
    expect(await libraryHomeWire(alpha)).toEqual({
      home_space_id: alphaId,
      home_writable: true,
    });
  });

  it("gives the id and `false` to a viewer of the home space", async () => {
    const viewer = await memberIn(alphaId, "viewer");
    expect(await homeWire(viewer)).toEqual({ home_space_id: alphaId, home_writable: false });
    expect(await libraryHomeWire(viewer)).toEqual({
      home_space_id: alphaId,
      home_writable: false,
    });
  });

  it("withholds the id from a reader whose only reach is another installation", async () => {
    // Beta's builder READS the package — it is installed there — and never
    // reaches Alpha. Emitting Alpha's id would hand them a space that does not
    // exist for them, which is the whole reason the field is projected.
    expect(await homeWire(beta)).toEqual({ home_space_id: null, home_writable: false });
    expect(await libraryHomeWire(beta)).toEqual({ home_space_id: null, home_writable: false });
  });

  it("gives the owner the id and `true`, and answers `null`/`true` for the org catalogue", async () => {
    expect(await homeWire(owner())).toEqual({ home_space_id: alphaId, home_writable: true });
    // A NULL home is the organization catalogue: the same `null` on the wire,
    // but writable — which is exactly why `home_writable` exists rather than a
    // client-side reading of the id.
    await db.update(packages).set({ homeSpaceId: null }).where(eq(packages.id, ID));
    expect(await homeWire(owner())).toEqual({ home_space_id: null, home_writable: true });
    expect(await homeWire(beta)).toEqual({ home_space_id: null, home_writable: false });
  });

  it("answers `false` on a SYSTEM package, which is the write route's verdict", async () => {
    // `home_writable` is the mutation route's WHOLE rule, not only its home
    // half: a system package is refused there before the home is consulted, so
    // an owner reading one must not be told they may write it. It answered
    // `true` through the NULL-home branch (`managesOrgCatalog`), i.e. a button
    // that 403s.
    const SYS = "@system/wire-skill";
    await seedPackage({
      id: SYS,
      orgId: null,
      type: "skill",
      source: "system",
      draftManifest: { name: SYS, version: "1.0.0", type: "skill", description: "d" },
      draftContent: "---\nname: wire-skill\ndescription: d\n---\n\nBody",
    });
    const res = await app.request(`/api/packages/skills/${SYS}`, { headers: owner() });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ home_space_id: null, home_writable: false });

    // The refusal it now agrees with.
    const row = await getDbRow(packages, eq(packages.id, SYS));
    const write = await app.request(`/api/packages/skills/${SYS}`, {
      method: "PUT",
      headers: { ...owner(), "Content-Type": "application/json" },
      body: JSON.stringify({ content: `${CONTENT} edited`, lock_version: row.lockVersion }),
    });
    expect(write.status, await write.clone().text()).toBe(403);
  });

  it("carries both on the per-type list", async () => {
    const res = await app.request("/api/packages/skills", { headers: alpha });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: (HomeWire & { id: string })[] };
    expect(body.data.find((p) => p.id === ID)).toMatchObject({
      home_space_id: alphaId,
      home_writable: true,
    });
  });
});

describe("creation sets the home", () => {
  it("homes a new package in the space it was created in", async () => {
    const res = await app.request("/api/packages/skills", {
      method: "POST",
      headers: { ...beta, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: { name: "@homes/fresh", version: "0.1.0", type: "skill", description: "d" },
        content: "---\nname: fresh\ndescription: d\n---\n\nBody",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = await getDbRow(packages, eq(packages.id, "@homes/fresh"));
    expect(row.homeSpaceId).toBe(betaId);
    await db.delete(packages).where(eq(packages.id, "@homes/fresh"));
  });
});
