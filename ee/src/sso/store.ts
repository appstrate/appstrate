// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { ssoConnections, ssoDomains, ssoSessions } from "../../drizzle/schema.ts";
import { getEeDb } from "../db.ts";

export type JoinRole = "member" | "guest";

/**
 * What applies to the addresses of one domain: the domain is verified by an
 * organization that has bound its Microsoft tenant. `null` from
 * {@link findDomainPolicy} means nothing applies.
 */
export interface DomainPolicy {
  orgId: string;
  domain: string;
  tenantId: string;
  joinRole: JoinRole;
  enforced: boolean;
}

export interface SsoConnection {
  orgId: string;
  tenantId: string | null;
  tenantLinkedAt: Date | null;
  joinRole: JoinRole;
  enforcedAt: Date | null;
}

export interface SsoDomain {
  id: string;
  orgId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

/** How long a Microsoft session record is kept: no platform session lives longer. */
const SESSION_RECORD_TTL_MS = 8 * 24 * 60 * 60 * 1000;

export async function findDomainPolicy(domain: string): Promise<DomainPolicy | null> {
  const [row] = await getEeDb()
    .select({
      orgId: ssoDomains.orgId,
      domain: ssoDomains.domain,
      tenantId: ssoConnections.tenantId,
      joinRole: ssoConnections.joinRole,
      enforcedAt: ssoConnections.enforcedAt,
    })
    .from(ssoDomains)
    .innerJoin(ssoConnections, eq(ssoConnections.orgId, ssoDomains.orgId))
    .where(
      and(
        eq(ssoDomains.domain, domain),
        isNotNull(ssoDomains.verifiedAt),
        isNotNull(ssoConnections.tenantId),
      ),
    )
    .limit(1);
  if (!row?.tenantId) return null;
  return {
    orgId: row.orgId,
    domain: row.domain,
    tenantId: row.tenantId,
    joinRole: row.joinRole as JoinRole,
    enforced: row.enforcedAt !== null,
  };
}

export async function getConnection(orgId: string): Promise<SsoConnection | null> {
  const [row] = await getEeDb()
    .select({
      orgId: ssoConnections.orgId,
      tenantId: ssoConnections.tenantId,
      tenantLinkedAt: ssoConnections.tenantLinkedAt,
      joinRole: ssoConnections.joinRole,
      enforcedAt: ssoConnections.enforcedAt,
    })
    .from(ssoConnections)
    .where(eq(ssoConnections.orgId, orgId))
    .limit(1);
  return row ? { ...row, joinRole: row.joinRole as JoinRole } : null;
}

/**
 * Write the given fields of `orgId`'s connection, creating the row on first
 * write. An UPDATE first: an `INSERT … ON CONFLICT` would hold the CHECK
 * constraints against the insert's defaults (no tenant) before the conflict.
 */
export async function saveConnection(
  orgId: string,
  fields: Partial<{
    tenantId: string | null;
    tenantLinkedBy: string | null;
    tenantLinkedAt: Date | null;
    joinRole: JoinRole;
    enforcedAt: Date | null;
    enforcedBy: string | null;
  }>,
): Promise<void> {
  const db = getEeDb();
  const values = { ...fields, updatedAt: new Date() };
  const updated = await db
    .update(ssoConnections)
    .set(values)
    .where(eq(ssoConnections.orgId, orgId))
    .returning({ orgId: ssoConnections.orgId });
  if (updated.length > 0) return;
  await db
    .insert(ssoConnections)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: ssoConnections.orgId, set: values });
}

export async function listDomains(orgId: string): Promise<SsoDomain[]> {
  return getEeDb()
    .select()
    .from(ssoDomains)
    .where(eq(ssoDomains.orgId, orgId))
    .orderBy(asc(ssoDomains.createdAt), asc(ssoDomains.domain));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDomain(orgId: string, id: string): Promise<SsoDomain | null> {
  // A caller-supplied id that is not a uuid is no row, not a 22P02 error.
  if (!UUID.test(id)) return null;
  const [row] = await getEeDb()
    .select()
    .from(ssoDomains)
    .where(and(eq(ssoDomains.orgId, orgId), eq(ssoDomains.id, id)))
    .limit(1);
  return row ?? null;
}

/** The organization that verified `domain`, if any. */
export async function verifiedOwnerOf(domain: string): Promise<string | null> {
  const [row] = await getEeDb()
    .select({ orgId: ssoDomains.orgId })
    .from(ssoDomains)
    .where(and(eq(ssoDomains.domain, domain), isNotNull(ssoDomains.verifiedAt)))
    .limit(1);
  return row?.orgId ?? null;
}

/** Insert a claim; `null` when the organization already claims the domain. */
export async function insertDomain(
  orgId: string,
  domain: string,
  verificationToken: string,
): Promise<SsoDomain | null> {
  const [row] = await getEeDb()
    .insert(ssoDomains)
    .values({ orgId, domain, verificationToken })
    .onConflictDoNothing({ target: [ssoDomains.orgId, ssoDomains.domain] })
    .returning();
  return row ?? null;
}

/**
 * Mark a claim verified. Resolves `false` when another organization verified
 * the same domain first: the partial unique index is the arbiter, so two
 * concurrent verifications cannot both win.
 */
export async function markDomainVerified(id: string, at: Date): Promise<boolean> {
  try {
    await getEeDb().update(ssoDomains).set({ verifiedAt: at }).where(eq(ssoDomains.id, id));
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

export async function deleteDomain(orgId: string, id: string): Promise<void> {
  await getEeDb()
    .delete(ssoDomains)
    .where(and(eq(ssoDomains.orgId, orgId), eq(ssoDomains.id, id)));
}

/** Record that `sessionId` was opened by a Microsoft sign-in from `tenantId`; drop stale records. */
export async function recordMicrosoftSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const db = getEeDb();
  await db
    .insert(ssoSessions)
    .values({ sessionId, userId, tenantId })
    .onConflictDoUpdate({ target: ssoSessions.sessionId, set: { userId, tenantId } });
  await db
    .delete(ssoSessions)
    .where(lt(ssoSessions.createdAt, new Date(Date.now() - SESSION_RECORD_TTL_MS)));
}

/** The Microsoft origin of a session, or `null` when another method opened it. */
export async function microsoftSessionOf(
  sessionId: string,
): Promise<{ userId: string; tenantId: string; createdAt: Date } | null> {
  const [row] = await getEeDb()
    .select({
      userId: ssoSessions.userId,
      tenantId: ssoSessions.tenantId,
      createdAt: ssoSessions.createdAt,
    })
    .from(ssoSessions)
    .where(eq(ssoSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** Drop everything an organization holds here. Idempotent. */
export async function deleteOrganization(orgId: string): Promise<void> {
  const db = getEeDb();
  await db.delete(ssoDomains).where(eq(ssoDomains.orgId, orgId));
  await db.delete(ssoConnections).where(eq(ssoConnections.orgId, orgId));
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
