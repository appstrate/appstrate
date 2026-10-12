// SPDX-License-Identifier: Apache-2.0

/**
 * The caller of a public proxy route (credential proxy, LLM proxy), read once from the request:
 * both accept the same bearer principals and name the run they act for the same way.
 */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { assertBearerOnly } from "./bearer-only.ts";

export interface ProxyCaller {
  /**
   * `apikey:<id>` or `user:<id>`: an API key and a JWT user never share a bucket, even when the
   * underlying ids happen to match.
   */
  principalId: string;
  authMethod: string;
  orgId: string;
  /** The JWT user, or the creator of the API key. */
  userId: string;
  /** Set when the call authenticated with an API key. */
  apiKeyId: string | null;
  /** The run the call names with `X-Run-Id`; `null` when the header is absent or empty. */
  runId: string | null;
}

/**
 * The caller of a proxy route, refused unless it is a bearer principal (`assertBearerOnly`).
 * `surfaceName` is the noun that refusal uses.
 */
export function readProxyCaller(c: Context<AppEnv>, surfaceName: string): ProxyCaller {
  const authMethod = c.get("authMethod");
  assertBearerOnly(authMethod, surfaceName, { firstPartyLoopback: c.get("firstPartyLoopback") });
  const apiKeyId = c.get("apiKeyId") || null;
  const userId = c.get("user").id;
  return {
    principalId: apiKeyId ? `apikey:${apiKeyId}` : `user:${userId}`,
    authMethod,
    orgId: c.get("orgId"),
    userId,
    apiKeyId,
    runId: c.req.header("X-Run-Id") || null,
  };
}
