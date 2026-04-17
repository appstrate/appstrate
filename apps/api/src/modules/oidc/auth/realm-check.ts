// SPDX-License-Identifier: Apache-2.0

/**
 * Shared realm-enforcement primitives for OIDC token-mint paths.
 *
 * Extracted out of `plugins.ts` so `guards.ts` can reuse the same check
 * on paths that don't flow through `@better-auth/oauth-provider`'s
 * `customAccessTokenClaims` — notably Better Auth's `deviceAuthorization()`
 * plugin at `/device/approve`, which mints BA sessions directly via the
 * internal adapter and bypasses oauth-provider entirely.
 *
 * The realm model itself is documented on `user.realm` in the auth schema
 * and inside `assertUserRealm` below. The short version: a single BA
 * `user` table stores both platform operators (realm=`"platform"`) and
 * end-users of `level=application` OIDC clients (realm=`"end_user:<appId>"`).
 * Without these checks, a session minted for one audience could mint a
 * token for another.
 */

import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";

/**
 * Subset of an OAuth client's `metadata` JSON blob relevant to realm
 * enforcement. The full shape is documented in `plugins.ts::ClientMetadata`;
 * this file only needs the level + referenced application id.
 */
export interface ClientAudienceMetadata {
  level?: "org" | "application" | "instance";
  referencedOrgId?: string;
  referencedApplicationId?: string;
  clientId?: string;
}

/**
 * Given an OAuth client's metadata, compute the realm a user must have to
 * be allowed to mint a token for this client. Mirrors the dispatch in
 * `plugins.ts::buildClaimsForClient` so `/oauth2/token` and
 * `/device/approve` apply the same audience-isolation rules.
 *
 * Throws on malformed metadata — rather than silently letting the mint
 * proceed — so drift between metadata and enforcement surfaces as a
 * structured OAuth2 error instead of a realm-bypass bug.
 */
export function expectedRealmForClient(metadata: ClientAudienceMetadata): string {
  if (metadata.level === "instance") return "platform";
  if (metadata.level === "org") return "platform";
  if (metadata.level === "application") {
    if (!metadata.referencedApplicationId) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client",
        error_description:
          "OAuth client metadata is malformed — application-level client is missing referencedApplicationId.",
      });
    }
    return `end_user:${metadata.referencedApplicationId}`;
  }
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client",
    error_description: "OAuth client metadata is missing level — cannot determine audience.",
  });
}

/**
 * Enforce realm isolation at token-mint time. The BA `user.realm` column
 * segregates audiences sharing the user table — platform operators
 * (`"platform"`) vs end-users of application-level OIDC clients
 * (`"end_user:<applicationId>"`). Without this check, a session minted
 * under one audience could mint a token for another (e.g. end-user of
 * app A requesting a token for app B, or a platform admin requesting an
 * end-user token for their own app).
 *
 * Throws RFC 6749 `access_denied` on mismatch — the satellite client
 * renders a clean auth error instead of a generic 500. Users recover by
 * logging out + re-authenticating with an account provisioned for the
 * target audience.
 *
 * Legacy users with NULL realm (pre-migration rows, should not exist
 * after `0001_add_user_realm` due to the default clause) are treated as
 * `"platform"` — safer default since the request-time realm guard in the
 * auth pipeline already blocks non-platform sessions from platform
 * routes.
 */
export async function assertUserRealm(
  userId: string,
  expected: string,
  context: { clientLevel: string; applicationId?: string | null; orgId?: string | null },
): Promise<void> {
  const [row] = await db
    .select({ realm: userTable.realm })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const actual = row?.realm ?? "platform";
  if (actual === expected) return;
  logger.warn("oidc: realm mismatch at token mint — rejecting", {
    module: "oidc",
    userId,
    expected,
    actual,
    clientLevel: context.clientLevel,
    applicationId: context.applicationId ?? null,
    orgId: context.orgId ?? null,
  });
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "This account is not permitted to sign in to this application. Sign out and use an account provisioned for this audience.",
  });
}
