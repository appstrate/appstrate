// SPDX-License-Identifier: Apache-2.0

/**
 * DELETE /api/orgs/:orgId — deletability is a PRECONDITION, not a side effect.
 *
 * Regression cover for a severe, user-triggerable, irreversible data-loss bug:
 * the route used to emit `onOrgDelete` first and call `deleteOrganization`
 * second. `deleteOrganization` refuses (from inside its transaction) while
 * runs are in progress, so an owner who clicked "delete org" during a run got
 * a 400 back — but the module handlers had already run their destructive,
 * non-transactional teardown (the ee module drains billing, cancels the
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
import { organizations, runs } from "@appstrate/db/schema";
import { reserveOrgDeletion } from "../../../src/services/organizations.ts";
import { createRun } from "../../../src/services/state/runs.ts";
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

/** The reservation stamp, or `null` when the org is not being deleted. */
async function deletingAt(orgId: string): Promise<Date | null> {
  const [row] = await db
    .select({ deletingAt: organizations.deletingAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.deletingAt ?? null;
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
      // Against the pre-fix ordering this array held one entry — the ee
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

/**
 * The precondition above is only worth what it still means once the modules
 * have acted. It used to mean nothing: it read outside any lock, so a run
 * admitted after it made the in-transaction check refuse a deletion whose
 * Stripe subscription was already cancelled. `reserveOrgDeletion` decides and
 * records the deletion in one transaction, under the same per-org key run
 * admission takes, and admission refuses a reserved org — so no run can appear
 * in that window, and a sequence interrupted after the reservation resumes.
 */
describe("DELETE /api/orgs/:orgId — deletion reservation", () => {
  beforeEach(async () => {
    await truncateAll();
    orgDeleteCalls = [];
    app = getTestApp();
  });

  it("refuses to admit a run into a reserved organization", async () => {
    const ctx = await createTestContext({ orgName: "Reserved Org" });
    const pkg = await seedPackage({ orgId: ctx.orgId });

    await reserveOrgDeletion(ctx.orgId);

    const err = await createRun(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { id: "run_after_reservation", packageId: pkg.id, actor: null, input: null },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as { code?: string } | null)?.code).toBe("org_deleting");
    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId));
    expect(rows).toHaveLength(0);
  });

  it("admits a run into an organization that is not reserved", async () => {
    // Control: the refusal above is the reservation, not the route being shut.
    const ctx = await createTestContext({ orgName: "Live Org" });
    const pkg = await seedPackage({ orgId: ctx.orgId });

    await createRun(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      { id: "run_no_reservation", packageId: pkg.id, actor: null, input: null },
    );

    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId));
    expect(rows).toHaveLength(1);
  });

  it("refuses the reservation while a run admitted earlier is still in progress", async () => {
    const ctx = await createTestContext({ orgName: "Busy Org" });
    await seedRunInOrg(ctx, "running");

    await expect(reserveOrgDeletion(ctx.orgId)).rejects.toThrow(/runs are in progress/);
    expect(await deletingAt(ctx.orgId)).toBeNull();
  });

  it("keeps the reservation when a later step fails, and the retry deletes", async () => {
    const ctx = await createTestContext({ orgName: "Interrupted Org" });
    await reserveOrgDeletion(ctx.orgId);
    const reservedAt = await deletingAt(ctx.orgId);
    expect(reservedAt).not.toBeNull();

    // Stand in for whatever failed after the reservation: the next attempt
    // cannot finish while this row is in progress.
    await seedRunInOrg(ctx, "running");
    const refused = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    expect(refused.status).toBe(400);
    // The reservation is not rolled back by the failure — it is the state the
    // retry is meant to find, unchanged.
    expect((await deletingAt(ctx.orgId))?.getTime()).toBe(reservedAt!.getTime());

    await db.update(runs).set({ status: "success" }).where(eq(runs.orgId, ctx.orgId));
    const retried = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    expect(retried.status).toBe(204);
    expect(await orgExists(ctx.orgId)).toBe(false);
  });
});
