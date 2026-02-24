import type { TFunction } from "i18next";

/**
 * Derive display properties (CSS classes, label) from a service connection status.
 */
export function getServiceStatusDisplay(
  status: string,
  t: TFunction,
): {
  statusDotClass: string;
  badgeClass: string;
  statusLabel: string;
} {
  const needsReconnection = status === "needs_reconnection";
  const isConnected = status === "connected";

  return {
    statusDotClass: needsReconnection ? "warning" : isConnected ? "connected" : "disconnected",
    badgeClass: needsReconnection
      ? "badge-warning"
      : isConnected
        ? "badge-success"
        : "badge-failed",
    statusLabel: needsReconnection
      ? t("services.needsReconnection", { defaultValue: "Reconnection needed" })
      : isConnected
        ? t("services.connected")
        : t("services.notConnected"),
  };
}
