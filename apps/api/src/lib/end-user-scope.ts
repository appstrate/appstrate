// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";

/**
 * Returns the endUserId to filter queries by, or null if no scoping is needed.
 *
 * - Non-end-user auth (session / API key): null — org-level access
 * - End-user admin role: null — sees all app data
 * - End-user member / viewer role: their endUserId — sees only own data
 */
export function getScopedEndUserId(c: Context<AppEnv>): string | null {
  const endUser = c.get("endUser");
  if (!endUser) return null;
  if (endUser.role === "admin") return null;
  return endUser.id;
}
