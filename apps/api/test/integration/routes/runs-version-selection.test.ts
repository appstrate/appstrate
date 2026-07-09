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

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageDistTags, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedPackageVersion, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

const AGENT = "@verorg/selector-agent";

describe("POST /api/agents/:scope/:name/run — version selector", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });
    await seedAgent({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
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
 * #878 — the reported shape, end to end through the route.
 *
 * An agent was published once while its manifest depended on `skill-x@^2.0.0`
 * (a version of skill-x that was never published). Its draft was later
 * rewritten to depend on skill-y instead, and never republished. Both skills
 * are installed and enabled in the application.
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
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }

    // Draft declares dep-y only; the published snapshot still declares dep-x.
    await seedAgent({
      id: DRIFTED,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: DRIFTED,
        version: "1.2.0",
        type: "agent",
        dependencies: { skills: { [DEP_Y]: "^1.0.0" } },
      },
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, DRIFTED);

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
    await seedAgent({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
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
      applicationId: ctx.defaultAppId,
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
      applicationId: ctx.defaultAppId,
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
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      versionLabel: null,
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("draft");
  });
});
