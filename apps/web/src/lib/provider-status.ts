import type { TFunction } from "i18next";

/**
 * Compute a summary string for the providers section.
 */
export function computeProvidersSummary(
  providers: Array<{ status: string; scopesSufficient?: boolean | null }>,
  t: TFunction<"flows">,
): { text: string; connectedCount: number; actionCount: number } | null {
  if (providers.length === 0) return null;

  let connectedCount = 0;
  let actionCount = 0;

  for (const svc of providers) {
    if (svc.status === "connected" && svc.scopesSufficient !== false) {
      connectedCount++;
    } else {
      actionCount++;
    }
  }

  const parts: string[] = [];
  if (connectedCount > 0) {
    parts.push(t("detail.servicesSummaryOk", { connected: connectedCount }));
  }
  if (actionCount > 0) {
    parts.push(t("detail.servicesSummaryAction", { count: actionCount }));
  }

  return { text: parts.join(" \u2014 "), connectedCount, actionCount };
}

/**
 * Append the profile name to a "Connected" label when the user has multiple profiles.
 */
export function connectedLabelWithProfile(
  baseLabel: string,
  profiles: Array<{ id: string; name: string }> | undefined,
  profileId: string | null,
): string {
  if (!profiles || profiles.length <= 1 || !profileId) return baseLabel;
  const profile = profiles.find((p) => p.id === profileId);
  return profile ? `${baseLabel} (${profile.name})` : baseLabel;
}
