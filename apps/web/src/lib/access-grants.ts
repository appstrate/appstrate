// SPDX-License-Identifier: Apache-2.0

import type { components } from "../api/client";

/** A CLI session or an MCP client grant, as the caller's own list returns it. */
export type AccessGrant = components["schemas"]["AccessGrant"];
/** The same grant in an org admin's list: its holder, and whether this admin may end it. */
export type OrgAccessGrant = components["schemas"]["OrgAccessGrant"];
/** What an MCP grant reaches (a CLI session reaches every org of its owner and names none). */
type GrantTarget = NonNullable<AccessGrant["target"]>;

/** Both lists show the caller's grants: a revocation from either refreshes both. */
export const ACCESS_GRANT_PATHS = [
  "/api/auth/access-grants",
  "/api/orgs/{orgId}/access-grants",
] as const;

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type UaCategory = "cli" | "github-action" | "unknown";

// A GitHub Action authenticates through the same CLI refresh-token family, and
// its identifier contains the CLI's: it is matched first.
export function categorizeUserAgent(ua: string | null): UaCategory {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  if (lower.includes("github-action") || lower.includes("appstrate-action")) return "github-action";
  if (lower.includes("appstrate-cli") || lower.includes("appstrate/")) return "cli";
  return "unknown";
}

/** What a reader calls the grant: the CLI's device, or the MCP client's declared name. */
export function grantLabel(
  grant: Pick<AccessGrant, "kind" | "device_name" | "user_agent" | "client_name">,
  t: Translate,
): string {
  if (grant.kind === "mcp") return grant.client_name || t("accessGrants.unnamedClient");
  if (grant.device_name) return grant.device_name;
  const category = categorizeUserAgent(grant.user_agent);
  if (category === "cli") return t("accessGrants.fallbackCli");
  if (category === "github-action") return t("accessGrants.fallbackGithubAction");
  return t("accessGrants.fallbackUnknown");
}

/** « Organisation Acme » or « Espace Ops », standing alone. */
export function grantTargetLabel(target: GrantTarget, t: Translate): string {
  return target.spaceId
    ? t("accessGrants.targetSpace", { name: target.space_name })
    : t("accessGrants.targetOrg", { name: target.org_name });
}

/** The same target inside a sentence: « l’organisation Acme », « l’espace Ops ». */
export function grantTargetPhrase(target: GrantTarget, t: Translate): string {
  return target.spaceId
    ? t("accessGrants.targetSpacePhrase", { name: target.space_name })
    : t("accessGrants.targetOrgPhrase", { name: target.org_name });
}

/**
 * The line under an MCP client's name: the origin the platform can vouch for
 * (its metadata document's host, or its redirect host), else what kind of
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

export function grantHolderLabel(grant: Pick<OrgAccessGrant, "user">): string {
  return grant.user.name || grant.user.email || grant.user.id;
}
