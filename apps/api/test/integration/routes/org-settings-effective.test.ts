// SPDX-License-Identifier: Apache-2.0

/**
 * The organization settings a reader sees: `personal_model_credentials` is
 * resolved to its default when the org never set it, and a PATCH of one key
 * never writes the default of another into the stored JSON.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { organizations, spaceRoles } from "@appstrate/db/schema";
import { deleteOrganization } from "../../../src/services/organizations.ts";
import { seedSpaceRole } from "../../helpers/seed.ts";
import { expectProblem } from "../../helpers/assertions.ts";

const app = getTestApp();

function settingsUrl(ctx: TestContext): string {
  return `/api/orgs/${ctx.orgId}/settings`;
}

function patchSettings(ctx: TestContext, body: Record<string, unknown>) {
  return app.request(settingsUrl(ctx), {
    method: "PATCH",
    headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function storedDefault(ctx: TestContext) {
  const [row] = await db
    .select({
      orgSettings: organizations.orgSettings,
      personalSpaceRoleId: organizations.personalSpaceRoleId,
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId));
  return row!;
}

async function readDefault(ctx: TestContext): Promise<string> {
  const res = await app.request(settingsUrl(ctx), { headers: { Cookie: ctx.cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { personal_space_role: string }).personal_space_role;
}

describe("organization settings — effective values", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("reads personal_model_credentials as true on an org that never set it", async () => {
    const res = await app.request(settingsUrl(ctx), { headers: { Cookie: ctx.cookie } });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { personal_model_credentials: boolean }).personal_model_credentials,
    ).toBe(true);
  });

  it("reads the stored false once the admin switches the policy off", async () => {
    expect((await patchSettings(ctx, { personal_model_credentials: false })).status).toBe(200);

    const res = await app.request(settingsUrl(ctx), { headers: { Cookie: ctx.cookie } });
    expect(
      ((await res.json()) as { personal_model_credentials: boolean }).personal_model_credentials,
    ).toBe(false);
  });

  it("a PATCH of another key does not write the personal_model_credentials default into storage", async () => {
    expect((await patchSettings(ctx, { dashboard_sso_enabled: true })).status).toBe(200);

    const [row] = await db
      .select({ orgSettings: organizations.orgSettings })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    expect(row!.orgSettings).toHaveProperty("dashboard_sso_enabled", true);
    expect(row!.orgSettings).not.toHaveProperty("personal_model_credentials");
  });

  it("reads personal_space_role as admin on an org that never set it", async () => {
    const res = await app.request(settingsUrl(ctx), { headers: { Cookie: ctx.cookie } });
    expect(((await res.json()) as { personal_space_role: string }).personal_space_role).toBe(
      "admin",
    );
  });

  it("stores any preset key as personal_space_role and refuses another string", async () => {
    for (const preset of ["operator", "builder", "runner", "viewer", "admin"]) {
      expect((await patchSettings(ctx, { personal_space_role: preset })).status, preset).toBe(200);
      const res = await app.request(settingsUrl(ctx), { headers: { Cookie: ctx.cookie } });
      expect(((await res.json()) as { personal_space_role: string }).personal_space_role).toBe(
        preset,
      );
    }
    for (const value of ["owner", "superuser", "srl_nope", 1]) {
      const res = await patchSettings(ctx, { personal_space_role: value });
      expect(res.status, String(value)).toBe(400);
    }
  });

  it("stores a custom role of this org, and 404s an id that is not one", async () => {
    const own = await seedSpaceRole({ orgId: ctx.orgId });
    const res = await patchSettings(ctx, { personal_space_role: own.id });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { personal_space_role: string }).personal_space_role).toBe(
      own.id,
    );

    const other = await createTestContext({ orgSlug: "neighbour" });
    const foreign = await seedSpaceRole({ orgId: other.orgId });
    for (const id of [foreign.id, "srl_11111111-1111-4111-8111-111111111111"]) {
      await expectProblem(await patchSettings(ctx, { personal_space_role: id }), 404, {
        code: "not_found",
      });
    }
    // The refused write changed nothing.
    const row = await storedDefault(ctx);
    expect(row.personalSpaceRoleId).toBe(own.id);
    expect(row.orgSettings).not.toHaveProperty("personal_space_role");
  });

  it("stores a custom default in the column and a preset in the key, never both, and reads either the same way", async () => {
    expect((await patchSettings(ctx, { dashboard_sso_enabled: true })).status).toBe(200);
    expect((await patchSettings(ctx, { personal_space_role: "operator" })).status).toBe(200);
    let row = await storedDefault(ctx);
    expect(row.orgSettings).toHaveProperty("personal_space_role", "operator");
    expect(row.personalSpaceRoleId).toBeNull();

    // A custom role: the column takes it and the key goes, other keys untouched.
    const own = await seedSpaceRole({ orgId: ctx.orgId });
    const patched = await patchSettings(ctx, { personal_space_role: own.id });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { personal_space_role: string }).personal_space_role).toBe(
      own.id,
    );
    row = await storedDefault(ctx);
    expect(row.personalSpaceRoleId).toBe(own.id);
    expect(row.orgSettings).not.toHaveProperty("personal_space_role");
    expect(row.orgSettings).toHaveProperty("dashboard_sso_enabled", true);
    expect(await readDefault(ctx)).toBe(own.id);

    // A PATCH of another key leaves the custom default where it is.
    expect((await patchSettings(ctx, { personal_model_credentials: false })).status).toBe(200);
    expect(await readDefault(ctx)).toBe(own.id);
    expect((await storedDefault(ctx)).personalSpaceRoleId).toBe(own.id);

    // Back to a preset: the key returns and the column clears.
    expect((await patchSettings(ctx, { personal_space_role: "viewer" })).status).toBe(200);
    row = await storedDefault(ctx);
    expect(row.orgSettings).toHaveProperty("personal_space_role", "viewer");
    expect(row.personalSpaceRoleId).toBeNull();
    expect(await readDefault(ctx)).toBe("viewer");
  });

  it("deleting the org removes it with its custom default, the FK notwithstanding", async () => {
    const own = await seedSpaceRole({ orgId: ctx.orgId });
    expect((await patchSettings(ctx, { personal_space_role: own.id })).status).toBe(200);
    await deleteOrganization(ctx.orgId);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    expect(org).toBeUndefined();
    const [role] = await db
      .select({ id: spaceRoles.id })
      .from(spaceRoles)
      .where(eq(spaceRoles.id, own.id));
    expect(role).toBeUndefined();
  });

  it("the schema refuses a row holding both shapes", async () => {
    const own = await seedSpaceRole({ orgId: ctx.orgId });
    expect((await patchSettings(ctx, { personal_space_role: "operator" })).status).toBe(200);
    let threw = false;
    try {
      await db
        .update(organizations)
        .set({ personalSpaceRoleId: own.id })
        .where(eq(organizations.id, ctx.orgId));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("a PATCH of another key does not write the personal_space_role default into storage", async () => {
    expect((await patchSettings(ctx, { dashboard_sso_enabled: true })).status).toBe(200);
    const [row] = await db
      .select({ orgSettings: organizations.orgSettings })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    expect(row!.orgSettings).not.toHaveProperty("personal_space_role");
  });
});
