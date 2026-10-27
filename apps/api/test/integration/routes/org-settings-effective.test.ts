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
});
