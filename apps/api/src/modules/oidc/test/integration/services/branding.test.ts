// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for `resolveAppBranding`.
 *
 * Exercises the full read path against real Postgres: the helper reads
 * `applications.settings.branding`, validates the shape against the
 * module-owned `AppBrandingSchema`, and falls back safely when the setting
 * is missing, malformed, or only partially populated.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { resolveAppBranding } from "../../../services/branding.ts";

async function seedAppWithSettings(settings: unknown): Promise<string> {
  const { id } = await createTestUser();
  const { defaultAppId } = await createTestOrg(id, { slug: "brand" });
  await db
    .update(applications)
    .set({ settings: settings as never })
    .where(eq(applications.id, defaultAppId));
  return defaultAppId;
}

describe("resolveAppBranding", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns fully-populated branding from a valid settings.branding blob", async () => {
    const appId = await seedAppWithSettings({
      branding: {
        name: "Mon Workspace",
        logoUrl: "https://cdn.example.com/logo.png",
        primaryColor: "#22c55e",
        accentColor: "#16a34a",
        supportEmail: "support@example.com",
        fromName: "Mon Workspace Support",
      },
    });
    const resolved = await resolveAppBranding(appId);
    expect(resolved.name).toBe("Mon Workspace");
    expect(resolved.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(resolved.primaryColor).toBe("#22c55e");
    expect(resolved.accentColor).toBe("#16a34a");
    expect(resolved.supportEmail).toBe("support@example.com");
    expect(resolved.fromName).toBe("Mon Workspace Support");
  });

  it("falls back to application.name when branding.name is missing", async () => {
    const appId = await seedAppWithSettings({ branding: { primaryColor: "#abcdef" } });
    const resolved = await resolveAppBranding(appId);
    // applications.name defaults to "Default" (seeded by createTestOrg)
    expect(resolved.name).toBe("Default");
    expect(resolved.primaryColor).toBe("#abcdef");
  });

  it("uses platform defaults when branding is absent entirely", async () => {
    const { id } = await createTestUser();
    const { defaultAppId } = await createTestOrg(id, { slug: "noset" });
    const resolved = await resolveAppBranding(defaultAppId);
    expect(resolved.name).toBeTruthy();
    expect(resolved.logoUrl).toBeNull();
    expect(resolved.primaryColor).toBe("#4f46e5");
    expect(resolved.accentColor).toBe("#4338ca");
  });

  it("safely falls back when branding has a malformed shape (Zod rejects)", async () => {
    // `primaryColor` must be #RRGGBB — a 3-char shorthand fails the regex
    // and the whole object is rejected; we fall back to defaults.
    const appId = await seedAppWithSettings({
      branding: { name: "X", primaryColor: "#fff" },
    });
    const resolved = await resolveAppBranding(appId);
    expect(resolved.name).toBeTruthy();
    expect(resolved.primaryColor).toBe("#4f46e5");
  });

  it("safely falls back when branding is not an object", async () => {
    const appId = await seedAppWithSettings({ branding: "not-an-object" });
    const resolved = await resolveAppBranding(appId);
    expect(resolved.primaryColor).toBe("#4f46e5");
  });

  it("accentColor inherits from primaryColor when primary is set and accent is not", async () => {
    const appId = await seedAppWithSettings({
      branding: { primaryColor: "#22c55e" },
    });
    const resolved = await resolveAppBranding(appId);
    expect(resolved.primaryColor).toBe("#22c55e");
    // Resolver uses parsed.accentColor ?? parsed.primaryColor ?? DEFAULT_ACCENT
    expect(resolved.accentColor).toBe("#22c55e");
  });
});
