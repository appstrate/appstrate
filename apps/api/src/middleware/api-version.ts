// SPDX-License-Identifier: Apache-2.0

/**
 * API versioning middleware — resolves and validates the effective API version.
 *
 * Resolution order: `Appstrate-Version` header > org settings > CURRENT_API_VERSION.
 * Sets `c.set("apiVersion")` and the `Appstrate-Version` response header on every request.
 *
 * An explicitly requested version that cannot be served is a 400 — from the
 * header AND from the org pin. Neither ever falls back to CURRENT_API_VERSION;
 * a silent downgrade would deliver a different API than the one the caller or
 * the org asked to be frozen on. Only the absence of any pin falls back.
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  CURRENT_API_VERSION,
  isValidVersionFormat,
  isVersionSupported,
  unsupportedApiVersion,
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
        throw unsupportedApiVersion(
          `API version "${version}" is not supported. Current version: ${CURRENT_API_VERSION}.`,
          "Appstrate-Version",
        );
      }
    } else {
      // Try org-pinned version
      const orgId = c.get("orgId");
      if (orgId && getOrgApiVersion) {
        const pinned = await getOrgApiVersion(orgId, c);
        if (pinned) {
          // A pin the server cannot serve is an error, never a silent
          // downgrade: falling back to CURRENT_API_VERSION would hand the org
          // a different (potentially breaking) API than the one it asked to be
          // frozen on, with nothing in the response saying so.
          //
          // Malformed pins ("garbage") and well-formed-but-dropped pins
          // ("2020-01-01") deliberately produce the SAME error. Unlike the
          // header path — where the caller typed the value and can be told
          // precisely what is wrong with their input — a pin is server-stored
          // state the caller cannot see or change. Both cases mean the same
          // thing to them ("this org's pinned version cannot be served") and
          // have the same remedy (an org admin re-pins the setting), so the
          // extra format/support distinction would be noise. `isVersionSupported`
          // already rejects malformed values, since they can never be members
          // of SUPPORTED_VERSIONS.
          //
          // No `param`. `param` is documented in `@appstrate/core/api-errors`
          // as mirroring Stripe's convention — it names the *request* parameter
          // at fault so a client can attach the message to the input that
          // produced it. Here the offending value is server-stored state, and
          // the request that trips this (`GET /api/runs`, say) need not carry
          // any parameter at all; naming `settings.api_version` would point a
          // consumer at a request field that does not exist. The offending
          // value is in `detail`, and `code` identifies the failure — the
          // header path keeps its `param` because there the caller really did
          // send `Appstrate-Version`.
          if (!isVersionSupported(pinned)) {
            throw unsupportedApiVersion(
              `The organization is pinned to API version "${pinned}", which is not supported. Current version: ${CURRENT_API_VERSION}.`,
            );
          }
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
