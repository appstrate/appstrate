// SPDX-License-Identifier: Apache-2.0

/**
 * API versioning middleware — resolves and validates the effective API version.
 *
 * Resolution order: `Appstrate-Version` header > org settings > CURRENT_API_VERSION.
 * Sets `c.set("apiVersion")` and the `Appstrate-Version` response header on every request.
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  CURRENT_API_VERSION,
  isValidVersionFormat,
  isVersionSupported,
} from "../lib/api-versions.ts";
import { ApiError } from "../lib/errors.ts";

export function apiVersion(
  // The resolver receives the request context so callers can read values
  // already stashed by earlier middleware (e.g. `orgSettings` loaded by
  // `requireOrgContext`) instead of re-querying per request.
  getOrgApiVersion?: (orgId: string, c: Context<AppEnv>) => Promise<string | null>,
) {
  return async (c: Context<AppEnv>, next: Next) => {
    let version = c.req.header("Appstrate-Version");

    if (version) {
      if (!isValidVersionFormat(version)) {
        throw new ApiError({
          status: 400,
          code: "invalid_api_version",
          title: "Invalid API Version",
          detail: `Invalid Appstrate-Version header format: "${version}". Expected YYYY-MM-DD.`,
          param: "Appstrate-Version",
        });
      }
      if (!isVersionSupported(version)) {
        throw new ApiError({
          status: 400,
          code: "unsupported_api_version",
          title: "Unsupported API Version",
          detail: `API version "${version}" is not supported. Current version: ${CURRENT_API_VERSION}.`,
          param: "Appstrate-Version",
        });
      }
    } else {
      // Try org-pinned version
      const orgId = c.get("orgId");
      if (orgId && getOrgApiVersion) {
        const pinned = await getOrgApiVersion(orgId, c);
        if (pinned && isVersionSupported(pinned)) {
          version = pinned;
        }
      }
      version ??= CURRENT_API_VERSION;
    }

    c.set("apiVersion", version);

    await next();

    c.header("Appstrate-Version", version);
  };
}
