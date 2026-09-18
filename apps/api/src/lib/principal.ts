// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";

/** The credential IS the platform user (RBAC spec §3.6): the one test every authority gate runs. */
export function isUserPrincipal(c: Context<AppEnv>): boolean {
  return c.get("principalKind") === "user";
}
