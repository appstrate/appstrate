// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application branding resolution for OIDC end-user flows.
 *
 * Core `applications.settings` is a free-form jsonb column — this module
 * imposes a shape on the `branding` subkey so every OIDC-owned surface
 * (emails, login + consent pages) renders with the satellite app's name,
 * logo and accent color instead of the platform default.
 *
 * The module stays the sole owner of the shape. Core does not know anything
 * about branding, and a future non-OIDC consumer that wants the same field
 * should import `AppBrandingSchema` from here rather than widening core.
 *
 * Resolution is defensive: anything missing or malformed falls back to
 * defaults derived from `applications.name` so the pages still render even
 * before the admin has configured branding.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";

/**
 * Branding logos are injected into `<img src="...">` on server-rendered
 * login/consent pages. A tenant admin compromise (or mistake) could
 * otherwise turn this into a tracking pixel pointed at an attacker host,
 * or worse a reference to an internal metadata endpoint. Reject any URL
 * that is not https:// and any URL that resolves to a blocked network
 * (RFC1918, link-local, cloud metadata, loopback, etc.).
 */
function isValidLogoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return !isBlockedUrl(raw);
}

export const AppBrandingSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    logoUrl: z.url().refine(isValidLogoUrl, "logoUrl must be a public HTTPS URL").optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be a 6-digit hex color")
      .optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a 6-digit hex color")
      .optional(),
    supportEmail: z.email().optional(),
    fromName: z.string().min(1).max(200).optional(),
  })
  .strict();

export type AppBranding = z.infer<typeof AppBrandingSchema>;

/** Fully resolved branding — every field populated, ready to render. */
export interface ResolvedAppBranding {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  supportEmail: string | null;
  fromName: string;
}

const DEFAULT_PRIMARY = "#4f46e5";
const DEFAULT_ACCENT = "#4338ca";

export const PLATFORM_DEFAULT_BRANDING: ResolvedAppBranding = {
  name: "Appstrate",
  logoUrl: null,
  primaryColor: DEFAULT_PRIMARY,
  accentColor: DEFAULT_ACCENT,
  supportEmail: null,
  fromName: "Appstrate",
};

/**
 * Read `applications.settings.branding` for the given app, validate it,
 * and return a fully-resolved branding with sensible fallbacks.
 *
 * Validation failures are logged (warn) but never throw — the page still
 * renders with defaults so a bad branding config can't take down an
 * end-user flow.
 */
export async function resolveAppBranding(applicationId: string): Promise<ResolvedAppBranding> {
  const [row] = await db
    .select({ name: applications.name, settings: applications.settings })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);

  const appName = row?.name ?? "Appstrate";
  const raw = extractBrandingCandidate(row?.settings);

  let parsed: AppBranding = {};
  if (raw !== null) {
    const result = AppBrandingSchema.safeParse(raw);
    if (result.success) {
      parsed = result.data;
    } else {
      logger.warn("oidc: invalid applications.settings.branding — falling back to defaults", {
        module: "oidc",
        applicationId,
        issues: result.error.issues as unknown as Record<string, unknown>[],
      });
    }
  }

  return {
    name: parsed.name ?? appName,
    logoUrl: parsed.logoUrl ?? null,
    primaryColor: parsed.primaryColor ?? DEFAULT_PRIMARY,
    accentColor: parsed.accentColor ?? parsed.primaryColor ?? DEFAULT_ACCENT,
    supportEmail: parsed.supportEmail ?? null,
    fromName: parsed.fromName ?? parsed.name ?? appName,
  };
}

/** Safe narrowing: settings is jsonb, treat as opaque until checked. */
function extractBrandingCandidate(settings: unknown): unknown {
  if (!settings || typeof settings !== "object") return null;
  const branding = (settings as Record<string, unknown>).branding;
  if (!branding || typeof branding !== "object") return null;
  return branding;
}
