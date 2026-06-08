// SPDX-License-Identifier: Apache-2.0

/**
 * Consent-time organization binding for self-service (DCR / CIMD) OAuth
 * clients.
 *
 * A self-service client (e.g. an MCP client like Claude Code) is
 * **instance-level** — one client serves a user who may belong to several
 * organizations. Unlike an org-level client, whose org is fixed at
 * registration (`metadata.referencedOrgId`), a self-service client has no
 * org baked in. We let the user pick the target org on the consent screen and
 * bind it to the issued token so the caller never has to send `X-Org-Id`.
 *
 * The binding rides Better Auth's `referenceId` seam: the
 * `postLogin.consentReferenceId` hook stamps the chosen org onto the
 * `oauthConsent` row and the authorization code; the plugin then surfaces it
 * to `customAccessTokenClaims` (and again on every refresh, as the
 * `referenceId` persists on the refresh-token row). The token carries the org
 * as its `org_id` claim and the auth strategy pins it.
 *
 * The hook only receives `{ user, session, scopes }` — not the consent form —
 * so the chosen org is passed to it out-of-band via an `AsyncLocalStorage`
 * scope wrapping the synchronous `oauth2Consent` call. This is leak-free (no
 * cross-request bleed, no TTL bookkeeping) because the write and the read
 * happen in the same call chain on the same worker.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, organizations } from "@appstrate/db/schema";
import type { OrgRole } from "../../../types/index.ts";

const pendingConsentOrg = new AsyncLocalStorage<string>();

/** Run `fn` with `orgId` bound as the pending consent org for this call chain. */
export function withPendingConsentOrg<T>(
  orgId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!orgId) return fn();
  return pendingConsentOrg.run(orgId, fn);
}

/** The org the user picked for the in-flight consent, if any (read by the hook). */
export function getPendingConsentOrg(): string | undefined {
  return pendingConsentOrg.getStore();
}

export interface ConsentOrgOption {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/** Organizations the user belongs to, for the consent-screen org picker. */
export async function listUserOrgs(userId: string): Promise<ConsentOrgOption[]> {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizations.name);
}

/** Whether the user is a member of the org — gate before binding a chosen org. */
export async function isUserOrgMember(userId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)))
    .limit(1);
  return Boolean(row);
}
