// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/agents/:scope/:name/run — `?version=` selector contract (#636)
 * and the `version_ref` field on the run wire DTO.
 *
 * The success path (which definition actually executes) is covered at the
 * service level in `services/agent-version-resolver.test.ts` — asserting a
 * 200 here would fire `executeAgentInBackground()` whose async tail races
 * the next test's `truncateAll()` (same flakiness rationale as the inline
 * run tests). The route-level contract pinned here is everything that fails
 * BEFORE the pipeline: selectors that cannot be satisfied must 404 rather than
 * silently falling back to the draft — INCLUDING an omitted selector, which is
 * strictly identical to `published` (the unified default; the working copy is
 * opt-in via `version=draft` only).
 */

import { asRecord } from "@appstrate/core/safe-json";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageDistTags, packages, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedSpacePackage,
  seedPackage,
  seedPackageShare,
  seedPackageVersion,
  seedPublishedVersion,
  seedRun,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import { buildMinimalZip, uploadPackageZip } from "../../../src/services/package-storage.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";

const app = getTestApp();

const AGENT = "@verorg/selector-agent";

describe("POST /api/agents/:scope/:name/run — version selector", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  });

  async function run(version?: string) {
    const qs = version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
    return app.request(`/api/agents/${AGENT}/run${qs}`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
  }

  it("returns 404 no_published_version for ?version=published on a never-published agent", async () => {
    const res = await run("published");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("no_published_version");
  });

  // CRITICAL: omitting the selector is the unified default `published`, NOT a
  // silent draft fallback. A never-published agent run with no `?version=`
  // must 404 (fails before the pipeline) instead of executing the working copy.
  it("returns 404 no_published_version when ?version is OMITTED on a never-published agent", async () => {
    const res = await run();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("no_published_version");
  });

  // Empty-string query (e.g. `?version=`) is normalised to omitted → same 404.
  it("returns 404 no_published_version for an empty ?version= on a never-published agent", async () => {
    const res = await run("");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("no_published_version");
  });

  it("returns 404 for an unresolvable version spec", async () => {
    const res = await run("9.9.9");
    expect(res.status).toBe(404);
  });
});

/**
 * `version=draft` is the AUTHOR's selector (plan decision 4).
 *
 * The working copy runs for whoever can WRITE the package — the type's `write`
 * in its home space — and for nobody else, wherever they launch it from. Before
 * this, the launch button sent `draft` for everyone, so a colleague, an
 * operator, a runner or a guest executed the author's uncommitted prompt with
 * their own credentials.
 *
 * The suite is a matrix on ONE fixture: one agent, one home, one published
 * version, and callers who differ only in what they hold in that home.
 */
describe("POST /api/agents/:scope/:name/run — who may run the draft", () => {
  let ctx: TestContext;
  /** The agent's HOME — a closed space, so a role there is an explicit row. */
  let homeId: string;
  /** A team space the package is OFFERED to: launching happens from here too. */
  let teamId: string;

  const DRAFT_AGENT = "@verorg/draft-authority";

  /** A member of the org holding `preset` in `spaceId`, and nothing elsewhere. */
  async function memberIn(
    spaceId: string | null,
    preset: "builder" | "viewer" | "operator" | "runner" | null,
    orgRole: "member" | "guest" = "member",
  ): Promise<Record<string, string>> {
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, orgRole);
    if (spaceId && preset) {
      await seedSpaceMember({ spaceId, userId: user.id, presetRole: preset });
    }
    return { Cookie: user.cookie, "X-Org-Id": ctx.orgId };
  }

  const launchDraft = (headers: Record<string, string>, spaceId: string) =>
    app.request(`/api/agents/${DRAFT_AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...headers, "X-Space-Id": spaceId, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });
    // Two of the cases below LAUNCH, so the org needs a model and the pipeline
    // an inert orchestrator; without them a 201 arrives as `model_not_configured`.
    await seedDefaultOrgModel(ctx);
    homeId = (await seedSpace({ orgId: ctx.orgId, name: "Home", visibility: "closed" })).id;
    teamId = (await seedSpace({ orgId: ctx.orgId, name: "Team", visibility: "closed" })).id;

    await seedAgent({
      id: DRAFT_AGENT,
      homeSpaceId: homeId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: { name: DRAFT_AGENT, version: "0.1.0", type: "agent" },
      draftContent: "The author's working copy.",
    });
    await seedPublishedVersion(DRAFT_AGENT, "0.1.0");
    // The draft is AHEAD of the publication — the author kept working. Without
    // that, `version_ref` reports the published label even for a draft run
    // (`run-context-builder`: an untouched draft IS the published version), and
    // the assertions below could not tell the two definitions apart.
    await db
      .update(packages)
      .set({ draftContent: "Edited after publishing.", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(packages.id, DRAFT_AGENT));
    // Placed and installed in BOTH spaces, so every refusal below is about the
    // selector and never about reach: a caller who could not see the agent
    // would 404 and prove nothing.
    await seedSpacePackage(homeId, DRAFT_AGENT);
    await seedPackageShare(teamId, DRAFT_AGENT);
    await seedSpacePackage(teamId, DRAFT_AGENT);
  });

  // `viewer` is deliberately absent: the preset holds no `agents:run`, so the
  // route's own permission guard refuses it before the selector is read. The
  // two presets below DO hold `agents:run`, which is what makes their refusal
  // attributable to `version=draft` and to nothing else.
  for (const preset of ["operator", "runner"] as const) {
    it(`refuses a ${preset} of the home with 403 draft_not_writable`, async () => {
      const headers = await memberIn(homeId, preset);
      const res = await launchDraft(headers, homeId);
      expect(res.status, await res.clone().text()).toBe(403);
      expect((await res.json()) as { code?: string }).toMatchObject({
        code: "draft_not_writable",
      });
      expect(await db.select().from(runs).where(eq(runs.packageId, DRAFT_AGENT))).toHaveLength(0);
    });
  }

  it("refuses a GUEST in the team space the package is offered to", async () => {
    const headers = await memberIn(teamId, "operator", "guest");
    const res = await launchDraft(headers, teamId);
    expect(res.status, await res.clone().text()).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "draft_not_writable" });
  });

  it("accepts the HOME's builder launching from another space entirely", async () => {
    // The authority is the package's home, not the space the request comes
    // from: a colleague who authors the agent in Home runs its working copy
    // from Team, where they are only an operator.
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "member");
    await seedSpaceMember({ spaceId: homeId, userId: user.id, presetRole: "builder" });
    await seedSpaceMember({ spaceId: teamId, userId: user.id, presetRole: "operator" });

    const res = await launchDraft({ Cookie: user.cookie, "X-Org-Id": ctx.orgId }, teamId);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ version_ref: "draft" });
    await waitForRunPipelineSettled();
  });

  it("refuses `/bundle?source=draft` to the same callers, and serves it to the author", async () => {
    // Exporting a draft IS running it, once `appstrate run --local` is in the
    // picture: the archive carries the unpublished manifest and prompt. A door
    // that hands the bytes over while the run route refuses them makes the 403
    // a formality, so both ask the one predicate.
    const operator = await memberIn(homeId, "operator");
    const refused = await app.request(`/api/agents/${DRAFT_AGENT}/bundle?source=draft`, {
      headers: { ...operator, "X-Space-Id": homeId },
    });
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect((await refused.json()) as { code?: string }).toMatchObject({
      code: "draft_not_writable",
    });

    const builder = await memberIn(homeId, "builder");
    const served = await app.request(`/api/agents/${DRAFT_AGENT}/bundle?source=draft`, {
      headers: { ...builder, "X-Space-Id": homeId },
    });
    expect(served.status, await served.clone().text()).toBe(200);
    expect(served.headers.get("X-Bundle-Version")).toBe("draft");
  });

  it("exports `?source=draft` with the dependencies resolved against PUBLISHED versions", async () => {
    // R9 — the exported archive is the server-side run, to the byte. A
    // `version=draft` run with no `dependency_overrides` resolves its skills
    // against published versions (`RunPackageCatalog`, the #666 rule), so the
    // export of the same selector must do the same. Walking the closure against
    // draft state instead handed the caller the working copy of a skill the run
    // route refuses them (`403 draft_not_writable`, the case above) — one
    // selector, two sets of bytes, decided by which door asked.
    //
    // The discriminator is the SKILL's home: the caller authors the AGENT in
    // Home and holds nothing in Team, where the skill lives. The skill is
    // offered and installed into Home so the export can reach it at all —
    // otherwise the 404 would prove reachability, not the closure rule.
    const SKILL = "@verorg/export-closure-skill";
    // §3.3 frontmatter: the published artifact is parsed on the way out, so a
    // bare body would fail assembly before the closure rule is even reached.
    const FRONTMATTER = "---\nname: export-closure-skill\ndescription: A skill.\n---\n\n";
    const PUBLISHED_MARKER = "PUBLISHED SKILL BODY";
    const DRAFT_MARKER = "DRAFT SKILL BODY";
    const PUBLISHED_BODY = `${FRONTMATTER}${PUBLISHED_MARKER}`;
    const DRAFT_BODY = `${FRONTMATTER}${DRAFT_MARKER}`;
    const enc = (text: string) => new TextEncoder().encode(text);
    const skillManifest = { name: SKILL, version: "1.0.0", type: "skill" };

    await seedPackage({
      id: SKILL,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      homeSpaceId: teamId,
      draftManifest: skillManifest,
      draftContent: DRAFT_BODY,
    });
    await seedPackageShare(homeId, SKILL);
    await seedSpacePackage(homeId, SKILL);
    await seedPublishedVersion(SKILL, "1.0.0", {
      manifest: skillManifest,
      content: PUBLISHED_BODY,
    });
    // The DRAFT bytes, which is what the old export shipped. They have to
    // differ from the published ones or the assertion below cannot tell the two
    // closures apart — a control, not decoration.
    await uploadPackageFiles("skills", ctx.orgId, SKILL, {
      "manifest.json": enc(JSON.stringify(skillManifest, null, 2)),
      "SKILL.md": enc(DRAFT_BODY),
    });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: DRAFT_AGENT,
          version: "0.1.0",
          type: "agent",
          dependencies: { skills: { [SKILL]: "^1.0.0" } },
        },
      })
      .where(eq(packages.id, DRAFT_AGENT));

    const builder = await memberIn(homeId, "builder");
    const res = await app.request(`/api/agents/${DRAFT_AGENT}/bundle?source=draft`, {
      headers: { ...builder, "X-Space-Id": homeId },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const bundle = readBundleFromBuffer(new Uint8Array(await res.arrayBuffer()));
    const skill = bundle.packages.get(`${SKILL}@1.0.0`);
    expect(skill).toBeDefined();
    const body = new TextDecoder().decode(skill!.files.get("SKILL.md"));
    expect(body).toContain(PUBLISHED_MARKER);
    expect(body).not.toContain(DRAFT_MARKER);
    // The ROOT is still the draft — that is the half `?source=draft` buys, and
    // an assertion that only checked the skill would pass on an export that
    // silently fell back to the published agent.
    expect(res.headers.get("X-Bundle-Version")).toBe("draft");
    const root = bundle.packages.get(bundle.root);
    expect(new TextDecoder().decode(root!.files.get("prompt.md"))).toBe("Edited after publishing.");
  });

  it("fails a `?source=draft` export whose skill has no published version, exactly as the run does", async () => {
    // The other half of R9: if the closure is the published one, a dependency
    // that was never published is unresolvable HERE, and it has to say so the
    // way a run says it — `422 dependency_unresolved` naming the skill — rather
    // than quietly substituting the working copy nobody published.
    const SKILL = "@verorg/never-published-skill";
    const enc = (text: string) => new TextEncoder().encode(text);
    const skillManifest = { name: SKILL, version: "1.0.0", type: "skill" };
    await seedPackage({
      id: SKILL,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      homeSpaceId: homeId,
      draftManifest: skillManifest,
      draftContent: "Never published.",
    });
    await seedSpacePackage(homeId, SKILL);
    await uploadPackageFiles("skills", ctx.orgId, SKILL, {
      "manifest.json": enc(JSON.stringify(skillManifest, null, 2)),
      "SKILL.md": enc("Never published."),
    });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: DRAFT_AGENT,
          version: "0.1.0",
          type: "agent",
          dependencies: { skills: { [SKILL]: "^1.0.0" } },
        },
      })
      .where(eq(packages.id, DRAFT_AGENT));

    const builder = await memberIn(homeId, "builder");
    const res = await app.request(`/api/agents/${DRAFT_AGENT}/bundle?source=draft`, {
      headers: { ...builder, "X-Space-Id": homeId },
    });
    expect(res.status, await res.clone().text()).toBe(422);
    const problem = (await res.json()) as { code?: string; detail?: string };
    expect(problem.code).toBe("dependency_unresolved");
    expect(problem.detail).toContain(SKILL);
  });

  it("refuses a `dependency_overrides` entry spelled draft on a skill the caller cannot write", async () => {
    // The same rule, one package down. The agent is the caller's to RUN; the
    // skill's working copy is not theirs to execute, and the manifest-key gate
    // downstream only proves the dependency is declared.
    const SKILL = "@verorg/dep-draft";
    const SKILL_MD = "# Dep draft\n\nThe skill's working copy.\n";
    await seedPackage({
      id: SKILL,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      homeSpaceId: homeId,
      draftManifest: { name: SKILL, version: "1.0.0", type: "skill" },
      draftContent: SKILL_MD,
    });
    await seedSpacePackage(homeId, SKILL);
    // The draft catalog assembles a skill from its STORED files, not from the
    // draft column, so the accepted case below has to reach a real closure.
    const enc = (text: string) => new TextEncoder().encode(text);
    await uploadPackageFiles("skills", ctx.orgId, SKILL, {
      "manifest.json": enc(
        JSON.stringify({ name: SKILL, version: "1.0.0", type: "skill" }, null, 2),
      ),
      "SKILL.md": enc(SKILL_MD),
    });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: DRAFT_AGENT,
          version: "0.1.0",
          type: "agent",
          dependencies: { skills: { [SKILL]: "^1.0.0" } },
        },
      })
      .where(eq(packages.id, DRAFT_AGENT));

    const launch = (headers: Record<string, string>) =>
      app.request(`/api/agents/${DRAFT_AGENT}/run?version=draft`, {
        method: "POST",
        headers: { ...headers, "X-Space-Id": homeId, "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, dependency_overrides: { [SKILL]: "draft" } }),
      });

    // A builder of the home writes the AGENT, so `?version=draft` is theirs —
    // which is what makes the refusal below attributable to the DEPENDENCY.
    const runnerHeaders = await memberIn(homeId, "runner");
    const refused = await launch(runnerHeaders);
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect((await refused.json()) as { code?: string; detail?: string }).toMatchObject({
      code: "draft_not_writable",
    });
    expect(await db.select().from(runs).where(eq(runs.packageId, DRAFT_AGENT))).toHaveLength(0);

    const builder = await memberIn(homeId, "builder");
    const accepted = await launch(builder);
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    await waitForRunPipelineSettled();
  });

  it("answers 400 before 403 for a `dependency_overrides` key the manifest does not declare", async () => {
    // R11 — the form before the authority. A key naming nothing the effective
    // manifest declares is a malformed request: the override would have had no
    // effect at all, and the run's own key gate has always said so with a 400.
    // But the authority gate ran first, so a typo came back as
    // `403 draft_not_writable` — a refusal that names an act the launch would
    // never perform, sending its reader after a grant they do not need.
    //
    // Asserted on the caller who would have got the 403, which is what makes
    // the 400 attributable to the ORDER and not to the caller holding more.
    const runner = await memberIn(homeId, "runner");
    const res = await app.request(`/api/agents/${DRAFT_AGENT}/run`, {
      method: "POST",
      headers: { ...runner, "X-Space-Id": homeId, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, dependency_overrides: { "@verorg/undeclared": "draft" } }),
    });
    expect(res.status, await res.clone().text()).toBe(400);
    const problem = (await res.json()) as { code?: string; detail?: string };
    expect(problem.code).toBe("invalid_request");
    expect(problem.detail).toContain("@verorg/undeclared");
    expect(await db.select().from(runs).where(eq(runs.packageId, DRAFT_AGENT))).toHaveLength(0);
  });

  /**
   * R10 — a stored value is not an act.
   *
   * The edit form reads a schedule, renders it, and posts every field back, so
   * `version_override: "draft"` arrives on a patch whose author only moved the
   * cron. Judging that echo refused the cron edit to every member who did not
   * write the AGENT — a 403 for a decision the request does not make, arriving
   * after the click, on a form the SPA deliberately opens so a reader can see
   * what the schedule says.
   *
   * The discriminating principal: a `builder` of TEAM holds `schedules:write`
   * there and nothing at all in HOME, where the agent lives. So they may write
   * the schedule row and may not write the agent — which is the whole point.
   */
  describe("editing a schedule whose stored selector is `draft`", () => {
    /** The author of both: writes the agent in HOME, writes schedules in TEAM. */
    async function authorHeaders(): Promise<Record<string, string>> {
      const user = await createTestUser();
      await addOrgMember(ctx.orgId, user.id, "member");
      await seedSpaceMember({ spaceId: homeId, userId: user.id, presetRole: "builder" });
      await seedSpaceMember({ spaceId: teamId, userId: user.id, presetRole: "builder" });
      return { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": teamId };
    }

    /** Writes schedules in TEAM, writes nothing in HOME. */
    const scheduleWriterHeaders = () => memberIn(teamId, "builder");

    async function createSchedule(
      headers: Record<string, string>,
      versionOverride?: string,
    ): Promise<string> {
      const res = await app.request(`/api/agents/${DRAFT_AGENT}/schedules`, {
        method: "POST",
        headers: { ...headers, "X-Space-Id": teamId, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "nightly",
          cron_expression: "0 3 * * *",
          timezone: "UTC",
          ...(versionOverride ? { version_override: versionOverride } : {}),
        }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    const patch = (headers: Record<string, string>, id: string, body: Record<string, unknown>) =>
      app.request(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { ...headers, "X-Space-Id": teamId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("accepts a patch that never names the selector but re-validates the input", async () => {
      // `input` is the field that re-opens the manifest decision, so this patch
      // DOES resolve the stored `draft` — and must still not be refused for it,
      // because the request never named it.
      const id = await createSchedule(await authorHeaders(), "draft");
      const res = await patch(await scheduleWriterHeaders(), id, { input: { note: "hi" } });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it("accepts a patch that echoes the stored selector back unchanged", async () => {
      // The form's own shape: it posts `version_override` on every save. Same
      // value in, same value out — nothing was decided, so nothing is judged.
      const id = await createSchedule(await authorHeaders(), "draft");
      const res = await patch(await scheduleWriterHeaders(), id, {
        cron_expression: "0 4 * * *",
        version_override: "draft",
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it("refuses a patch that MOVES the selector to draft", async () => {
      // The control that keeps the two above from being a hole: naming the
      // draft on a schedule that did not hold it IS the act, and it answers to
      // the agent's author.
      const id = await createSchedule(await authorHeaders(), "published");
      const res = await patch(await scheduleWriterHeaders(), id, { version_override: "draft" });
      expect(res.status, await res.clone().text()).toBe(403);
      expect((await res.json()) as { code?: string }).toMatchObject({
        code: "draft_not_writable",
      });
    });

    it("accepts a patch that CLEARS the selector off a draft schedule", async () => {
      // Dropping back to the published default takes nothing away from anyone.
      const id = await createSchedule(await authorHeaders(), "draft");
      const res = await patch(await scheduleWriterHeaders(), id, { version_override: null });
      expect(res.status, await res.clone().text()).toBe(200);
    });
  });

  it("leaves the published launch open to the same callers it refuses the draft to", async () => {
    // The discriminating control: what the refusals above are about is the
    // SELECTOR, not the caller's right to run the agent at all.
    const headers = await memberIn(homeId, "runner");
    const res = await app.request(`/api/agents/${DRAFT_AGENT}/run`, {
      method: "POST",
      headers: { ...headers, "X-Space-Id": homeId, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ version_ref: "0.1.0" });
    await waitForRunPipelineSettled();
  });
});

/**
 * #878 — the reported shape, end to end through the route.
 *
 * An agent was published once while its manifest depended on `skill-x@^2.0.0`
 * (a version of skill-x that was never published). Its draft was later
 * rewritten to depend on skill-y instead, and never republished. Both skills
 * are installed and enabled in the space.
 *
 * Pre-fix, every published run answered `400 missing_skill: Required skill
 * '@verorg/dep-x' is not installed` — pointing at a skill that IS installed and
 * that the executing definition may not even reference, because readiness
 * compared the PUBLISHED manifest's deps against the DRAFT's resolved closure.
 *
 * Post-fix the closure follows the resolved version, so readiness passes and
 * the run fails on the honest cause: the pin `^2.0.0` has no published version.
 * That failure is raised before the run row is created, so nothing executes.
 */
describe("POST /api/agents/:scope/:name/run — published deps diverged from the draft (#878)", () => {
  let ctx: TestContext;

  const DRIFTED = "@verorg/drifted-agent";
  const DEP_X = "@verorg/dep-x";
  const DEP_Y = "@verorg/dep-y";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });

    for (const id of [DEP_X, DEP_Y]) {
      await seedPackage({
        id,
        type: "skill",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: { name: id, version: "1.0.0", type: "skill" },
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    }

    // Draft declares dep-y only; the published snapshot still declares dep-x.
    await seedAgent({
      id: DRIFTED,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: DRIFTED,
        version: "1.2.0",
        type: "agent",
        dependencies: { skills: { [DEP_Y]: "^1.0.0" } },
      },
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, DRIFTED);

    const version = await seedPackageVersion({
      packageId: DRIFTED,
      version: "1.0.0",
      manifest: {
        name: DRIFTED,
        version: "1.0.0",
        type: "agent",
        dependencies: { skills: { [DEP_X]: "^2.0.0" } },
      },
    });
    await uploadPackageZip(
      DRIFTED,
      "1.0.0",
      buildMinimalZip(asRecord(version.manifest), "Published prompt.", "prompt.md"),
    );
    await db
      .insert(packageDistTags)
      .values({ packageId: DRIFTED, tag: "latest", versionId: version.id });
  });

  async function runDrifted(version?: string) {
    const qs = version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
    const res = await app.request(`/api/agents/${DRIFTED}/run${qs}`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    return { status: res.status, body: (await res.json()) as { code?: string; detail?: string } };
  }

  it("never reports missing_skill for an installed skill (?version=published)", async () => {
    const { status, body } = await runDrifted("published");

    expect(body.code).not.toBe("missing_skill");
    expect(status).not.toBe(400);
  });

  it("fails on the honest cause — the unpublished pin — with 422 dependency_unresolved", async () => {
    const { status, body } = await runDrifted("published");

    expect(status).toBe(422);
    expect(body.code).toBe("dependency_unresolved");
    expect(body.detail).toContain(`'${DEP_X}@^2.0.0'`);
  });

  it("an omitted selector behaves identically to published", async () => {
    const { status, body } = await runDrifted();

    expect(status).toBe(422);
    expect(body.code).toBe("dependency_unresolved");
  });

  it("no run row is created — the failure precedes execution", async () => {
    await runDrifted("published");

    const rows = await db.select().from(runs).where(eq(runs.packageId, DRIFTED));
    expect(rows).toEqual([]);
  });
});

describe("GET /api/runs/:id — version_ref persistence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  });

  async function getRunWire(runId: string) {
    const res = await app.request(`/api/runs/${runId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      version_label: string | null;
      version_ref: string;
    };
  }

  it("reports the stored ref for a dirty-draft run (label carries the published base)", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      versionLabel: "2.1.0",
      versionRef: "draft",
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("draft");
    expect(wire.version_label).toBe("2.1.0");
    expect("version_dirty" in wire).toBe(false);
  });

  it("reports the semver for a published-definition run", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      versionLabel: "2.1.0",
      versionRef: "2.1.0",
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("2.1.0");
  });

  it("defaults to 'draft' for a run on a never-published agent (NULL label)", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      versionLabel: null,
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("draft");
  });
});
