// SPDX-License-Identifier: Apache-2.0

import type { components } from "../api/client";

/** A CLI session or an MCP client grant, as the caller's own list returns it. */
export type AccessGrant = components["schemas"]["AccessGrant"];
/** The same grant in an org admin's list: its holder, and whether this admin may end it. */
export type OrgAccessGrant = components["schemas"]["OrgAccessGrant"];

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type UaCategory = "cli" | "github-action" | "unknown";

// A GitHub Action authenticates through the same CLI refresh-token family.
// Its identifier is a strict substring of the broader CLI one, so it is
// matched first.
export function categorizeUserAgent(ua: string | null): UaCategory {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  if (lower.includes("github-action") || lower.includes("appstrate-action")) {
    return "github-action";
  }
  if (lower.includes("appstrate-cli") || lower.includes("appstrate/")) {
    return "cli";
  }
  return "unknown";
}

// Older CLI rows stored the literal `"unknown"` when no IP was available:
// render nothing for it, as for a missing one.
export function displayIp(ip: string | null): string | null {
  if (!ip) return null;
  return ip === "unknown" ? null : ip;
}

/** What a reader calls the grant: the CLI's device, or the MCP client's name. */
export function grantLabel(
  grant: Pick<AccessGrant, "kind" | "device_name" | "user_agent" | "client_name">,
  t: Translate,
): string {
  if (grant.kind === "mcp") return grant.client_name || t("accessGrants.unnamedClient");
  if (grant.device_name) return grant.device_name;
  const category = categorizeUserAgent(grant.user_agent);
  if (category === "cli") return t("devices.fallbackCli");
  if (category === "github-action") return t("devices.fallbackGithubAction");
  return t("devices.fallbackUnknown");
}

/** What an MCP grant reaches, named: « Organisation Acme » or « Espace Ops ». */
export function grantTargetLabel(grant: Pick<AccessGrant, "target">, t: Translate): string {
  const target = grant.target;
  if (!target) return t("accessGrants.targetAllOrgs");
  if (target.spaceId) {
    return t("accessGrants.targetSpace", { name: target.space_name ?? target.spaceId });
  }
  return t("accessGrants.targetOrg", { name: target.org_name ?? target.orgId });
}

/**
 * The second line under an MCP client's name: where it verifiably comes from
 * (the host of its metadata document, or of its redirect), else what kind of
 * client it is. The name above it is the client's own claim.
 */
export function grantOriginLabel(
  grant: Pick<AccessGrant, "client_origin" | "client_registration">,
  t: Translate,
): string {
  if (grant.client_origin) return grant.client_origin;
  if (grant.client_registration === "dynamic") return t("accessGrants.originLocal");
  return t("accessGrants.originUnknown");
}

export function grantHolderLabel(grant: OrgAccessGrant): string {
  return grant.user.name || grant.user.email || grant.user.id;
}
