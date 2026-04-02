// SPDX-License-Identifier: Apache-2.0

import type { EmailType, EmailRenderer } from "@appstrate/emails";
import { registerEmailOverrides } from "@appstrate/emails";
import { setBeforeSignupHook } from "@appstrate/db/auth";
import { db } from "@appstrate/db/client";
import { organizationMembers, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export interface CloudModule {
  initCloud(config: {
    databaseUrl: string;
    redisUrl: string;
    appUrl: string;
    sendMail?: (to: string, subject: string, html: string) => void;
    getOrgAdminEmails?: (orgId: string) => Promise<string[]>;
  }): Promise<void>;
  legalUrls?: { terms?: string; privacy?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QuotaExceededError: new (...args: any[]) => Error & { code: "QUOTA_EXCEEDED" };
  publicPaths: string[];
  cloudHooks: {
    checkQuota(orgId: string, runningRunCount: number): Promise<void>;
    recordUsage(orgId: string, runId: string, cost: number): Promise<void>;
    onOrgCreated(orgId: string, userEmail: string): Promise<void>;
    onOrgDeleted(orgId: string): Promise<void>;
    onBeforeSignup?(email: string): void;
  };
  registerCloudRoutes(app: unknown): void;
  emailOverrides?: Partial<{ [K in EmailType]: EmailRenderer<K> }>;
}

let _cloud: CloudModule | null | undefined = undefined;

export async function loadCloud(): Promise<CloudModule | null> {
  if (_cloud !== undefined) return _cloud;

  // Step 1: try to import the module — if absent, OSS mode (silent)
  let mod: CloudModule;
  try {
    // Dynamic import of optional module — variable specifier prevents tsc from resolving it statically
    const pkg = "@appstrate/cloud";
    mod = await import(/* webpackIgnore: true */ pkg);
  } catch {
    _cloud = null;
    return null;
  }

  // Step 2: dynamic import of sendMail to avoid circular dep at module load time
  // (email.ts → app-config.ts → cloud-loader.ts). Safe here: loadCloud() runs at
  // boot time, all modules are already loaded.
  const { sendMail } = await import("../services/email.ts");

  // Step 3: module found — init must succeed or crash (misconfiguration)
  await mod.initCloud({
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
    appUrl: process.env.APP_URL ?? "http://localhost:3000",
    sendMail,
    getOrgAdminEmails: getAdminEmails,
  });

  // Step 4: register email template overrides if provided
  if (mod.emailOverrides) {
    registerEmailOverrides(mod.emailOverrides);
  }

  // Step 5: wire domain allowlist hook into Better Auth signup
  if (mod.cloudHooks.onBeforeSignup) {
    setBeforeSignupHook(mod.cloudHooks.onBeforeSignup);
  }

  _cloud = mod;
  return _cloud;
}

export function getCloudModule(): CloudModule | null {
  if (_cloud === undefined) throw new Error("Cloud not initialized. Call loadCloud() at boot.");
  return _cloud;
}

// ---------------------------------------------------------------------------
// DI: org admin emails query
// ---------------------------------------------------------------------------

async function getAdminEmails(orgId: string): Promise<string[]> {
  const admins = await db
    .select({ email: user.email })
    .from(organizationMembers)
    .innerJoin(user, eq(organizationMembers.userId, user.id))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.role, ["admin", "owner"]),
      ),
    );

  return admins.map((a) => a.email);
}
