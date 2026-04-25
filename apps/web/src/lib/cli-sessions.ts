// SPDX-License-Identifier: Apache-2.0

export interface CliSessionDisplay {
  familyId: string;
  deviceName: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastUsedIp: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export type UaCategory = "cli" | "github-action" | "unknown";

// Any GitHub Action invocation surfaces here when the action authenticates
// via the same `cli_refresh_tokens` family. We branch on the action's UA
// first because its identifier is a strict substring of the broader CLI
// category and would otherwise be swallowed.
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

// Pre-fix rows persisted the literal `"unknown"` string when no IP was
// available. Treat that as a falsy display value so the dashboard renders
// nothing instead of the noise word — matches the post-fix NULL handling.
export function displayIp(ip: string | null): string | null {
  if (!ip) return null;
  return ip === "unknown" ? null : ip;
}

export function deriveLabel(
  session: Pick<CliSessionDisplay, "deviceName" | "userAgent">,
  t: (k: string) => string,
): string {
  if (session.deviceName) return session.deviceName;
  const category = categorizeUserAgent(session.userAgent);
  if (category === "cli") return t("devices.fallbackCli");
  if (category === "github-action") return t("devices.fallbackGithubAction");
  return t("devices.fallbackUnknown");
}
