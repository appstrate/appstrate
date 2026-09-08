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
 * end-users of `level=space` OIDC clients (realm=`"end_user:<spaceId>"`).
 * Without these checks, a session minted for one audience could mint a
 * token for another.
 */

import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";

/**
 * The `oauth_clients` scoping columns realm enforcement reads.
 */
export interface ClientAudienceMetadata {
  level?: "org" | "space" | "instance";
  referencedOrgId?: string;
  referencedSpaceId?: string;
}

/**
 * The realm a user must hold to mint a token for this client. Mirrors the
 * dispatch in `plugins.ts::buildClaimsForClient` so `/oauth2/token` and
 * `/device/approve` apply the same audience-isolation rules.
 *
 * Throws on a scoping row that cannot name an audience, so drift surfaces as a
 * structured OAuth2 error instead of a realm-bypass bug.
 */
export function expectedRealmForClient(metadata: ClientAudienceMetadata): string {
  if (metadata.level === "instance") return "platform";
  if (metadata.level === "org") return "platform";
  if (metadata.level === "space") {
    if (!metadata.referencedSpaceId) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_client",
        error_description:
          "OAuth client is malformed — a space-level client is missing referencedSpaceId.",
      });
    }
    return `end_user:${metadata.referencedSpaceId}`;
  }
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client",
    error_description: "OAuth client is missing level — cannot determine audience.",
  });
}

/**
 * Enforce realm isolation at token-mint time. The BA `user.realm` column
 * segregates audiences sharing the user table — platform operators
 * (`"platform"`) vs end-users of space-level OIDC clients
 * (`"end_user:<spaceId>"`). Without this check, a session minted
 * under one audience could mint a token for another (e.g. end-user of
 * space A requesting a token for space B, or a platform admin requesting an
 * end-user token for their own space).
 *
 * Throws RFC 6749 `access_denied` on mismatch — the satellite client
 * renders a clean auth error instead of a generic 500. Users recover by
 * logging out + re-authenticating with an account provisioned for the
 * target audience.
 */
export async function assertUserRealm(
  userId: string,
  expected: string,
  context: { clientLevel: string; spaceId?: string | null; orgId?: string | null },
): Promise<void> {
  const [row] = await db
    .select({ realm: userTable.realm })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const actual = row?.realm;
  if (actual === expected) return;
  logger.warn("oidc: realm mismatch at token mint — rejecting", {
    module: "oidc",
    userId,
    expected,
    actual,
    clientLevel: context.clientLevel,
    spaceId: context.spaceId ?? null,
    orgId: context.orgId ?? null,
  });
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "This account is not permitted to sign in to this space. Sign out and use an account provisioned for this audience.",
  });
}
