// SPDX-License-Identifier: Apache-2.0

/**
 * DELETE /api/orgs/:orgId — deletability is a PRECONDITION, not a side effect.
 *
 * Cover for a severe, user-triggerable, irreversible data-loss shape: emitting
 * `onOrgDelete` before `deleteOrganization`. `deleteOrganization` refuses (from
 * inside its transaction) while runs are in progress, so an owner who clicks
 * "delete org" during a run gets a 400 back — and with that ordering the module
 * handlers would already have run their destructive, non-transactional teardown
 * (the ee module drains billing, cancels the Stripe subscription and drops the
 * billing account; the mcp module drops the org from the RFC 8707 audience
 * allowlist), leaving the organization gutted with no repair path.
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

/**
 * Work a handler does while the platform waits on it. Set by the test that
 * needs a handler to change the org's deletability mid-sequence; null
 * everywhere else, so every other test sees a pure recorder.
 */
let onOrgDeleteSideEffect: ((orgId: string) => Promise<void>) | null = null;

const recordingModule: AppstrateModule = {
  manifest: { id: "test-org-delete-recorder", name: "Org delete recorder", version: "1.0.0" },
  async init() {},
  events: {
    onOrgDelete: async (orgId: string) => {
      orgDeleteCalls.push(orgId);
      await onOrgDeleteSideEffect?.(orgId);
    },
  },
};

function moduleCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => async () => {},
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
    onOrgDeleteSideEffect = null;
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
      // With the emit ahead of the refusal this array holds one entry — the ee
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

  it("emits onOrgDelete a second time when a handler leaves the org undeletable", async () => {
    // The reservation cannot stop a run a HANDLER creates — it runs after the
    // stamp, inside the platform's own process. So the in-transaction count
    // still refuses, and the retry is the recovery: the contract is that a
    // handler tolerates being called again for the same org.
    const ctx = await createTestContext({ orgName: "Handler Blocks Org" });
    let inserted = false;
    onOrgDeleteSideEffect = async (orgId) => {
      if (inserted || orgId !== ctx.orgId) return;
      inserted = true;
      await seedRunInOrg(ctx, "running");
    };

    const refused = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code?: string }).code).toBe("delete_failed");
    expect(orgDeleteCalls).toEqual([ctx.orgId]);
    expect(await orgExists(ctx.orgId)).toBe(true);

    await db.update(runs).set({ status: "success" }).where(eq(runs.orgId, ctx.orgId));

    const retried = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });
    expect(retried.status).toBe(204);
    expect(orgDeleteCalls).toEqual([ctx.orgId, ctx.orgId]);
    expect(await orgExists(ctx.orgId)).toBe(false);
  });
});

/**
 * The precondition above is only worth what it still means once the modules
 * have acted, and a read outside any lock means nothing there: a run admitted
 * after it would make the in-transaction check refuse a deletion whose Stripe
 * subscription is already cancelled. `reserveOrgDeletion` decides and records
 * the deletion in one transaction, under the same per-org key run admission
 * takes, and admission refuses a reserved org — so no run can appear in that
 * window, and a sequence interrupted after the reservation resumes.
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

  it("completes a DELETE that finds the reservation already standing", async () => {
    // The reservation is never lifted, so the retry of an interrupted DELETE
    // finds it in place. That is the recovery path, and it must be a no-op for
    // the reservation and a completion for the deletion.
    const ctx = await createTestContext({ orgName: "Already Reserved Org" });
    await reserveOrgDeletion(ctx.orgId);
    const reservedAt = await deletingAt(ctx.orgId);
    expect(reservedAt).not.toBeNull();

    const res = await app.request(`/api/orgs/${ctx.orgId}`, {
      method: "DELETE",
      headers: { Cookie: ctx.cookie },
    });

    expect(res.status).toBe(204);
    expect(await orgExists(ctx.orgId)).toBe(false);
  });

  it("shows the standing reservation on the organization resource", async () => {
    // A reservation nothing surfaces is a state an operator cannot see. It is
    // on the detail read and the listing, null everywhere else.
    const ctx = await createTestContext({ orgName: "Visible Reservation Org" });

    const before = (await (
      await app.request(`/api/orgs/${ctx.orgId}`, { headers: { Cookie: ctx.cookie } })
    ).json()) as { deleting_at: string | null };
    expect(before.deleting_at).toBeNull();

    await reserveOrgDeletion(ctx.orgId);

    const after = (await (
      await app.request(`/api/orgs/${ctx.orgId}`, { headers: { Cookie: ctx.cookie } })
    ).json()) as { deleting_at: string | null };
    expect(after.deleting_at).toBe((await deletingAt(ctx.orgId))!.toISOString());

    const listed = (await (
      await app.request("/api/orgs", { headers: { Cookie: ctx.cookie } })
    ).json()) as { data: { id: string; deleting_at: string | null }[] };
    expect(listed.data.find((o) => o.id === ctx.orgId)?.deleting_at).toBe(after.deleting_at);
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
