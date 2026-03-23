/**
 * API versioning middleware — resolves and validates the effective API version.
 *
 * Resolution order: `Appstrate-Version` header > org settings > CURRENT_API_VERSION.
 * Sets `c.set("apiVersion")` and the `Appstrate-Version` response header on every request.
 * Adds `Sunset` response header when the resolved version is deprecated.
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  CURRENT_API_VERSION,
  isValidVersionFormat,
  isVersionSupported,
  getVersionSunsetDate,
} from "../lib/api-versions.ts";
import { ApiError } from "../lib/errors.ts";

/**
 * Optional dependency: resolve pinned version from org settings.
 * Injected to allow unit testing without DB access.
 */
export interface ApiVersionDeps {
  getOrgApiVersion?: (orgId: string) => Promise<string | null>;
}

const defaultDeps: ApiVersionDeps = {};

export function apiVersion(deps: ApiVersionDeps = defaultDeps) {
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
      if (orgId && deps.getOrgApiVersion) {
        const pinned = await deps.getOrgApiVersion(orgId);
        if (pinned && isVersionSupported(pinned)) {
          version = pinned;
        }
      }
      version ??= CURRENT_API_VERSION;
    }

    c.set("apiVersion", version);

    await next();

    c.header("Appstrate-Version", version);

    const sunset = getVersionSunsetDate(version);
    if (sunset) {
      c.header("Sunset", sunset);
    }
  };
}
