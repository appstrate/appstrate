import type { TFunction } from "i18next";

interface ServiceStatusDisplay {
  statusDotClass: string;
  badgeClass: string;
  statusLabel: string;
  statusIcon: string;
}

const STATUS_MAP: Record<string, Omit<ServiceStatusDisplay, "statusLabel"> & { labelKey: string }> =
  {
    connected: {
      statusDotClass: "connected",
      badgeClass: "badge-success",
      statusIcon: "✓",
      labelKey: "services.connected",
    },
    needs_reconnection: {
      statusDotClass: "warning",
      badgeClass: "badge-warning",
      statusIcon: "⚠",
      labelKey: "services.needsReconnection",
    },
  };

const DEFAULT_STATUS = {
  statusDotClass: "disconnected",
  badgeClass: "badge-failed",
  statusIcon: "✕",
  labelKey: "services.notConnected",
};

/**
 * Derive display properties (CSS classes, label, icon) from a service connection status.
 */
export function getServiceStatusDisplay(status: string, t: TFunction): ServiceStatusDisplay {
  const entry = STATUS_MAP[status] ?? DEFAULT_STATUS;
  return { ...entry, statusLabel: t(entry.labelKey, { defaultValue: entry.labelKey }) };
}

/**
 * Compute a summary string for the services section.
 */
export function computeServicesSummary(
  services: Array<{ status: string; scopesSufficient?: boolean | null }>,
  t: TFunction<"flows">,
): { text: string; connectedCount: number; actionCount: number } | null {
  if (services.length === 0) return null;

  let connectedCount = 0;
  let actionCount = 0;

  for (const svc of services) {
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

  return { text: parts.join(" — "), connectedCount, actionCount };
}
