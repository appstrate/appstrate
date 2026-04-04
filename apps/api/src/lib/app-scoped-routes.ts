// SPDX-License-Identifier: Apache-2.0

/** Returns true if the given API path requires application context (X-App-Id). */
export function requiresAppContext(path: string): boolean {
  if (path.startsWith("/api/agents")) return true;
  if (path.startsWith("/api/runs")) return true;
  if (path.startsWith("/api/schedules")) return true;
  if (path.startsWith("/api/webhooks")) return true;
  if (path.startsWith("/api/end-users")) return true;
  if (path.startsWith("/api/api-keys")) return true;
  if (path.startsWith("/api/realtime")) return true;
  if (path.startsWith("/api/packages")) return true;
  if (path.startsWith("/api/notifications")) return true;
  return false;
}
