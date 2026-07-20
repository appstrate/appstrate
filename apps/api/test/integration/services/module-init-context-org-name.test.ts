// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";

/**
 * `ctx.getOrgName` is the DI seam modules (e.g. @appstrate/cloud) use to label
 * org-scoped emails with the organization concerned. It must resolve the real
 * display name and return null — never a placeholder — for a missing org.
 */
describe("ModuleInitContext.getOrgName", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("resolves the organization display name", async () => {
    const { orgId } = await createTestContext({ orgName: "Acme Corp" });

    const ctx = buildModuleInitContext();
    expect(await ctx.getOrgName!(orgId)).toBe("Acme Corp");
  });

  it("returns null for an unknown org id", async () => {
    const ctx = buildModuleInitContext();
    expect(await ctx.getOrgName!(crypto.randomUUID())).toBeNull();
  });
});
