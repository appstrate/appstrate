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
 * BEFORE the pipeline: explicit selectors that cannot be satisfied must 404
 * rather than silently falling back to the draft.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
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

  it("returns 404 for an unresolvable version spec", async () => {
    const res = await run("9.9.9");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/runs/:id — version_ref derivation", () => {
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
      version_dirty: boolean;
      version_ref: string;
    };
  }

  it("reports 'draft' for a dirty-draft run (label carries the published base)", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      versionLabel: "2.1.0",
      versionDirty: true,
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("draft");
    expect(wire.version_label).toBe("2.1.0");
    expect(wire.version_dirty).toBe(true);
  });

  it("reports the semver for a published-definition run", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      versionLabel: "2.1.0",
      versionDirty: false,
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("2.1.0");
  });

  it("reports 'draft' for a run on a never-published agent (NULL label)", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      versionLabel: null,
      versionDirty: false,
    });
    const wire = await getRunWire(row.id);
    expect(wire.version_ref).toBe("draft");
  });
});
