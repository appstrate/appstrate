// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The platform handles captured at `init(ctx)`. Platform rows (members,
 * sessions, audit) are reached through them, never through SQL of this
 * package: its tables share the database, not the licence.
 */

import type { ModuleInitContext, ModuleOrgMember, PlatformServices } from "@appstrate/core/module";

export interface EePlatform {
  services: Pick<PlatformServices, "logger" | "audit" | "members" | "access">;
  getOrgMembers(orgId: string, userIds: readonly string[]): Promise<ModuleOrgMember[]>;
}

let platform: EePlatform | null = null;

export function setPlatform(ctx: Pick<ModuleInitContext, "services" | "getOrgMembers">): void {
  platform = { services: ctx.services, getOrgMembers: ctx.getOrgMembers };
}

export function getPlatform(): EePlatform {
  if (!platform) throw new Error("@appstrate/ee is not initialized: init() captures the platform.");
  return platform;
}

/** The caller's role in `orgId`, or `null` when not a member. */
export async function orgRoleOf(orgId: string, userId: string): Promise<string | null> {
  const [member] = await getPlatform().getOrgMembers(orgId, [userId]);
  return member?.role ?? null;
}
