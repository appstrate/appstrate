// SPDX-License-Identifier: Apache-2.0

/**
 * Inline shadow packages must be invisible to every user-facing catalog
 * endpoint — they're an implementation detail of POST /api/runs/inline, not
 * real installable agents. These tests lock down that invariant across the
 * surface so a future refactor can't accidentally leak them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const app = getTestApp();

const shadowManifest = {
  name: "@inline/r-test",
  displayName: "Shadow Agent",
  version: "0.0.0",
  type: "agent",
  description: "Inline",
  schemaVersion: "1.0.0",
} as unknown as AgentManifest;

describe("ephemeral filter — catalog endpoints hide inline shadows", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ephemfilter" });

    // Seed one real agent to make sure we're filtering rather than returning
    // empty lists by accident.
    await seedPackage({
      id: "@ephemfilter/real-agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await installPackage(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      "@ephemfilter/real-agent",
    );

    // Seed a shadow package that MUST be invisible.
    await insertShadowPackage({
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      manifest: shadowManifest,
      prompt: "hi",
    });
  });

  it("GET /api/agents does not include inline shadows", async () => {
    const res = await app.request("/api/agents", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((a) => a.id);
    expect(ids).toContain("@ephemfilter/real-agent");
    for (const id of ids) {
      expect(id.startsWith("@inline/")).toBe(false);
    }
  });

  it("GET /api/agents/@inline/<slug> returns 404 even if the shadow row exists", async () => {
    // Extract a shadow id straight from DB — we don't expose it from any API.
    const { db } = await import("../../helpers/db.ts");
    const { packages } = await import("@appstrate/db/schema");
    const { eq } = await import("drizzle-orm");
    const shadows = await db.select().from(packages).where(eq(packages.ephemeral, true));
    expect(shadows.length).toBeGreaterThan(0);

    const shadowId = shadows[0]!.id; // "@inline/r-<uuid>"
    const res = await app.request(`/api/agents/${shadowId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(404);
  });

  it("installPackage rejects a shadow id as if it did not exist", async () => {
    // Belt-and-braces: the catalog filter should prevent the UI path, but the
    // service layer itself must refuse to install an ephemeral shadow under any
    // circumstance — otherwise a crafted API call could bypass the filter.
    const { db } = await import("../../helpers/db.ts");
    const { packages } = await import("@appstrate/db/schema");
    const { eq } = await import("drizzle-orm");
    const [shadow] = await db.select().from(packages).where(eq(packages.ephemeral, true));
    expect(shadow).toBeDefined();

    await expect(
      installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, shadow!.id),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
