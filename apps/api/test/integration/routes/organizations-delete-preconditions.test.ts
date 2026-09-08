// SPDX-License-Identifier: Apache-2.0

/**
 * DELETE /api/orgs/:orgId — deletability is a PRECONDITION, not a side effect.
 *
 * Regression cover for a severe, user-triggerable, irreversible data-loss bug:
 * the route used to emit `onOrgDelete` first and call `deleteOrganization`
 * second. `deleteOrganization` refuses (from inside its transaction) while
 * runs are in progress, so an owner who clicked "delete org" during a run got
 * a 400 back — but the module handlers had already run their destructive,
 * non-transactional teardown (the cloud module drains billing, cancels the
 * Stripe subscription and drops the billing account; the mcp module drops the
 * org from the RFC 8707 audience allowlist). The organization survived,
 * gutted, with no repair path.
 *
 * The load-bearing assertion in this file is therefore NEGATIVE: with an
 * in-progress run, the `onOrgDelete` handler must NOT have been invoked at
 * all. Asserting only the 400 would have passed against the buggy code.
 *
 * Wiring note: `emitEvent` fans out over the module-loader's own registry
 * (`_modules`), which `getTestApp({ modules })` does not populate — that
 * option only mounts routers. So the recording module is registered through
 * `loadModulesFromInstances`, the same entry point the production boot path
 * uses, and torn down with `resetModules()`.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { organizations } from "@appstrate/db/schema";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";

/** Every `onOrgDelete` fan-out observed since the last `beforeEach`. */
let orgDeleteCalls: string[] = [];

const recordingModule: AppstrateModule = {
  manifest: { id: "test-org-delete-recorder", name: "Org delete recorder", version: "1.0.0" },
  async init() {},
  events: {
    onOrgDelete: (orgId: string) => {
      orgDeleteCalls.push(orgId);
    },
  },
};

function moduleCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgOwnerEmails: async () => [],
    getOrgMembers: async () => [],
    getOrgName: async () => null,
    services: {} as ModuleInitContext["services"],
  };
}

let app: ReturnType<typeof getTestApp>;

/** Seed a run in `status` inside the context's org + default space. */
async function seedRunInOrg(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
  status: "pending" | "running" | "success",
): Promise<void> {
  const pkg = await seedPackage({ orgId: ctx.orgId });
  await seedRun({
    packageId: pkg.id,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    status,
  });
}

async function orgExists(orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return rows.length > 0;
}

describe("DELETE /api/orgs/:orgId — deletability precondition", () => {
  beforeEach(async () => {
    await truncateAll();
    orgDeleteCalls = [];
    resetModules();
    await loadModulesFromInstances([recordingModule], moduleCtx());
    // Call AFTER loading: getTestApp() re-registers the RBAC snapshot from the
    // preload-discovered modules, undoing the empty snapshot that
    // loadModulesFromInstances just installed for our single fake module.
    app = getTestApp();
  });

  afterAll(() => {
    // Leave the global module registry as we found it (empty) so no later
    // test file sees a stray `onOrgDelete` listener, and restore the RBAC
    // provider that resetModules() nulls out.
    resetModules();
    getTestApp();
  });

  for (const status of ["running", "pending"] as const) {
    it(`refuses with 400 delete_failed and does NOT emit onOrgDelete when a run is ${status}`, async () => {
      const ctx = await createTestContext({ orgName: "Busy Org" });
      await seedRunInOrg(ctx, status);

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("delete_failed");

      // THE assertion: no module may observe a deletion that never happened.
      // Against the pre-fix ordering this array held one entry — the cloud
      // module would already have cancelled the subscription by here.
      expect(orgDeleteCalls).toEqual([]);

      // And the org is intact (the transaction rolled back).
      expect(await orgExists(ctx.orgId)).toBe(true);
    });
  }

  it("deletes and emits onOrgDelete exactly once when no run is in progress", async () => {
    const ctx = await createTestContext({ orgName: "Idle Org" });
    // A finished run must not block deletion — only pending/running do.
    await seedRunInOrg(ctx, "success");

    const res = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });

    expect(res.status).toBe(204);
    expect(orgDeleteCalls).toEqual([ctx.orgId]);
    expect(await orgExists(ctx.orgId)).toBe(false);
  });
});
