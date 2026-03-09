import type { TFunction } from "i18next";

interface ProviderStatusDisplay {
  statusDotClass: string;
  badgeClass: string;
  statusLabel: string;
  statusIcon: string;
}

const STATUS_MAP: Record<
  string,
  Omit<ProviderStatusDisplay, "statusLabel"> & { labelKey: string }
> = {
  connected: {
    statusDotClass: "connected",
    badgeClass: "badge-success",
    statusIcon: "\u2713",
    labelKey: "services.connected",
  },
  needs_reconnection: {
    statusDotClass: "warning",
    badgeClass: "badge-warning",
    statusIcon: "\u26A0",
    labelKey: "services.needsReconnection",
  },
};

const DEFAULT_STATUS = {
  statusDotClass: "disconnected",
  badgeClass: "badge-failed",
  statusIcon: "\u2715",
  labelKey: "services.notConnected",
};

/**
 * Derive display properties (CSS classes, label, icon) from a provider connection status.
 */
export function getProviderStatusDisplay(status: string, t: TFunction): ProviderStatusDisplay {
  const entry = STATUS_MAP[status] ?? DEFAULT_STATUS;
  return { ...entry, statusLabel: t(entry.labelKey, { defaultValue: entry.labelKey }) };
}

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
