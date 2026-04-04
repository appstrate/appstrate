// SPDX-License-Identifier: Apache-2.0

/**
 * Returns true if the given API path requires application context (X-App-Id).
 *
 * Allowlist approach: only the routes below are exempt. Everything else under
 * /api/ is app-scoped by default, so new routes automatically require app
 * context without needing manual registration here.
 */
export function requiresAppContext(path: string): boolean {
  if (!path.startsWith("/api/")) return false;

  // Routes that do NOT require app context
  if (path.startsWith("/api/organizations")) return false;
  if (path.startsWith("/api/orgs")) return false;
  if (path.startsWith("/api/auth/")) return false;
  if (path.startsWith("/api/profile")) return false;
  if (path.startsWith("/api/applications")) return false;
  if (path.startsWith("/api/providers")) return false;
  if (path.startsWith("/api/connections")) return false;
  if (path.startsWith("/api/connection-profiles")) return false;
  if (path.startsWith("/api/proxies")) return false;
  if (path.startsWith("/api/models")) return false;
  if (path.startsWith("/api/provider-keys")) return false;
  if (path.startsWith("/api/welcome")) return false;
  if (path === "/api/config" || path === "/api/config/") return false;
  if (path === "/api/docs" || path === "/api/openapi.json") return false;

  return true;
}
