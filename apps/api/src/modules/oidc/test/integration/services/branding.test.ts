// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for `resolveSpaceBranding`.
 *
 * Exercises the full read path against real Postgres: the helper reads
 * `spaces.settings.branding`, validates the shape against the
 * module-owned `SpaceBrandingSchema`, and falls back safely when the setting
 * is missing, malformed, or only partially populated.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import {
  resolveSpaceBranding,
  resolveBrandingForClient,
  PLATFORM_DEFAULT_BRANDING,
} from "../../../services/branding.ts";

async function seedSpaceWithSettings(settings: unknown): Promise<string> {
  const { id } = await createTestUser();
  const { defaultSpaceId } = await createTestOrg(id, { slug: "brand" });
  await db
    .update(spaces)
    .set({ settings: settings as never })
    .where(eq(spaces.id, defaultSpaceId));
  return defaultSpaceId;
}

describe("resolveSpaceBranding", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns fully-populated branding from a valid settings.branding blob", async () => {
    const spaceId = await seedSpaceWithSettings({
      branding: {
        name: "Mon Workspace",
        logo_url: "https://cdn.example.com/logo.png",
        primary_color: "#22c55e",
        accent_color: "#16a34a",
        support_email: "support@example.com",
        from_name: "Mon Workspace Support",
      },
    });
    const resolved = await resolveSpaceBranding(spaceId);
    expect(resolved.name).toBe("Mon Workspace");
    expect(resolved.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(resolved.primaryColor).toBe("#22c55e");
    expect(resolved.accentColor).toBe("#16a34a");
    expect(resolved.supportEmail).toBe("support@example.com");
    expect(resolved.fromName).toBe("Mon Workspace Support");
  });

  it("falls back to space.name when branding.name is missing", async () => {
    const spaceId = await seedSpaceWithSettings({ branding: { primary_color: "#abcdef" } });
    const resolved = await resolveSpaceBranding(spaceId);
    // spaces.name defaults to "Default" (seeded by createTestOrg)
    expect(resolved.name).toBe("Default");
    expect(resolved.primaryColor).toBe("#abcdef");
  });

  it("uses platform defaults when branding is absent entirely", async () => {
    const { id } = await createTestUser();
    const { defaultSpaceId } = await createTestOrg(id, { slug: "noset" });
    const resolved = await resolveSpaceBranding(defaultSpaceId);
    expect(resolved.name).toBeTruthy();
    expect(resolved.logoUrl).toBeNull();
    expect(resolved.primaryColor).toBe("#4f46e5");
    expect(resolved.accentColor).toBe("#4338ca");
  });

  it("safely falls back when branding has a malformed shape (Zod rejects)", async () => {
    // `primary_color` must be #RRGGBB — a 3-char shorthand fails the regex
    // and the whole object is rejected; we fall back to defaults.
    const spaceId = await seedSpaceWithSettings({
      branding: { name: "X", primary_color: "#fff" },
    });
    const resolved = await resolveSpaceBranding(spaceId);
    expect(resolved.name).toBeTruthy();
    expect(resolved.primaryColor).toBe("#4f46e5");
  });

  it("safely falls back when branding is not an object", async () => {
    const spaceId = await seedSpaceWithSettings({ branding: "not-an-object" });
    const resolved = await resolveSpaceBranding(spaceId);
    expect(resolved.primaryColor).toBe("#4f46e5");
  });

  // C4 — logo_url host/scheme allowlist.
  // Arbitrary URLs in <img src> would let a compromised admin plant
  // tracking beacons or point at internal metadata endpoints. The schema
  // refinement rejects non-HTTPS schemes and SSRF targets; the resolver
  // falls back to defaults instead of throwing.
  const blockedLogoUrls: Array<[string, string]> = [
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:image/png;base64,AAAA"],
    ["http scheme", "http://cdn.example.com/logo.png"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["RFC1918", "https://10.0.0.1/logo.png"],
  ];
  for (const [label, logoUrl] of blockedLogoUrls) {
    it(`safely falls back when logo_url is blocked (${label})`, async () => {
      const spaceId = await seedSpaceWithSettings({
        branding: { name: "X", logo_url: logoUrl },
      });
      const resolved = await resolveSpaceBranding(spaceId);
      expect(resolved.logoUrl).toBeNull();
    });
  }

  it("accepts a public https logo_url", async () => {
    const spaceId = await seedSpaceWithSettings({
      branding: { logo_url: "https://cdn.example.com/logo.png" },
    });
    const resolved = await resolveSpaceBranding(spaceId);
    expect(resolved.logoUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("accent_color inherits from primary_color when primary is set and accent is not", async () => {
    const spaceId = await seedSpaceWithSettings({
      branding: { primary_color: "#22c55e" },
    });
    const resolved = await resolveSpaceBranding(spaceId);
    expect(resolved.primaryColor).toBe("#22c55e");
    // Resolver uses parsed.accent_color ?? parsed.primary_color ?? DEFAULT_ACCENT
    expect(resolved.accentColor).toBe("#22c55e");
  });

  it("ignores a branding blob with camelCase keys and falls back to defaults", async () => {
    const spaceId = await seedSpaceWithSettings({
      branding: {
        name: "Mon Workspace",
        logoUrl: "https://cdn.example.com/logo.png",
        primaryColor: "#22c55e",
      },
    });
    const resolved = await resolveSpaceBranding(spaceId);
    // `.strict()` refuses the unknown keys, so the whole blob is ignored.
    expect(resolved.name).toBe("Default");
    expect(resolved.logoUrl).toBeNull();
    expect(resolved.primaryColor).toBe("#4f46e5");
  });
});

describe("resolveBrandingForClient — instance-level", () => {
  // Instance-level clients don't touch the DB so these cases need no seeding.
  // They guard the end-user-visible brand for OIDC_INSTANCE_CLIENTS entries:
  // the operator-declared `name` MUST surface under the logo on the login
  // page instead of the generic "Appstrate" platform default.
  it("uses the client name when present", async () => {
    const resolved = await resolveBrandingForClient({
      level: "instance",
      name: "Mon Admin Dashboard",
      referencedOrgId: null,
      referencedSpaceId: null,
    });
    expect(resolved.name).toBe("Mon Admin Dashboard");
    expect(resolved.fromName).toBe("Mon Admin Dashboard");
    expect(resolved.logoUrl).toBe(PLATFORM_DEFAULT_BRANDING.logoUrl);
    expect(resolved.primaryColor).toBe(PLATFORM_DEFAULT_BRANDING.primaryColor);
  });

  it("falls back to platform default name when client.name is null", async () => {
    const resolved = await resolveBrandingForClient({
      level: "instance",
      name: null,
      referencedOrgId: null,
      referencedSpaceId: null,
    });
    expect(resolved.name).toBe(PLATFORM_DEFAULT_BRANDING.name);
    expect(resolved.fromName).toBe(PLATFORM_DEFAULT_BRANDING.fromName);
  });
});
