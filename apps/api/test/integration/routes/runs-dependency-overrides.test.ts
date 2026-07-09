// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/agents/:scope/:name/run — `dependency_overrides` contract (#666)
 * and the `dependency_overrides` field on the run wire DTO.
 *
 * Like the version-selector tests, the success path (a run that actually
 * executes with overridden deps) is covered at the service level in
 * `services/build-agent-package-bundle.test.ts` — asserting a 201 here would
 * fire `executeAgentInBackground()` whose async tail races the next test's
 * `truncateAll()`. The route-level contract pinned here is everything that
 * resolves BEFORE the background execution starts: body validation (400),
 * the loud unsatisfiable-pin failure (422), and the wire-DTO echo.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

const AGENT = "@deporg/dep-agent";

describe("POST /api/agents/:scope/:name/run — dependency_overrides validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deporg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  });

  async function run(body: Record<string, unknown>) {
    // `?version=draft` — the seeded agent is never published; the dependency
    // gates under test fire only once version resolution passes (omit ≡
    // `published` → 404 on a never-published agent). Draft is the explicit
    // opt-in that reaches those gates.
    return app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a non-object dependency_overrides with 400", async () => {
    const res = await run({ input: {}, dependency_overrides: "draft" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid per-dependency spec with 400", async () => {
    const res = await run({
      input: {},
      dependency_overrides: { "@deporg/skill": "not a version!!" },
    });
    expect(res.status).toBe(400);
  });
});

// NOTE: the loud unsatisfiable-pin failure (DEPENDENCY_UNRESOLVED → 422) is
// proven at the service level in `services/build-agent-package-bundle.test.ts`
// ("fails loud for a never-published dependency"). Reproducing it through the
// run route would first have to satisfy the orthogonal agent-readiness
// `missing_skill` gate (which requires the declared skill to resolve against
// the org catalog), so the catalog-level test is the right altitude.

describe("GET /api/runs/:id — dependency_overrides echo", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deporg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  });

  it("echoes the persisted dependency_overrides on the run wire DTO", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      dependencyOverrides: { "@deporg/skill": "draft" },
    });
    const res = await app.request(`/api/runs/${row.id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as { dependency_overrides: Record<string, string> | null };
    expect(wire.dependency_overrides).toEqual({ "@deporg/skill": "draft" });
  });

  it("reports null dependency_overrides for a run that used manifest pins", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
    });
    const res = await app.request(`/api/runs/${row.id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as { dependency_overrides: Record<string, string> | null };
    expect(wire.dependency_overrides).toBeNull();
  });
});
