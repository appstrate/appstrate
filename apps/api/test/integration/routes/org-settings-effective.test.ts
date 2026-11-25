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
import { organizations } from "@appstrate/db/schema";
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
    const [row] = await db
      .select({ orgSettings: organizations.orgSettings })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    expect(row!.orgSettings).toHaveProperty("personal_space_role", own.id);
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
