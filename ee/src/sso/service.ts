// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * An organization's enterprise sign-in settings, and the one rule over who
 * changes them: an OWNER, from a DASHBOARD SESSION. Every door (REST, MCP's
 * `invoke_operation`, the CLI) reaches these functions, so the rule lives here
 * and not on a route: whoever sets the identity provider holds every account
 * of the domain, owners included, and an MCP instance token acting for an
 * owner is the `user` principal (RBAC spec §7) — only `authMethod` tells the
 * dashboard from a token.
 */

import { ApiError, conflict, forbidden, notFound } from "@appstrate/core/api-errors";
import type { AuditPayload } from "@appstrate/core/module";
import { hasVerificationRecord, type TxtResolver } from "./dns.ts";
import { newVerificationToken, normalizeDomain, verificationRecordName } from "./domain.ts";
import {
  deleteDomain,
  getConnection,
  getDomain,
  insertDomain,
  listDomains,
  markDomainVerified,
  saveConnection,
  verifiedOwnerOf,
  type JoinRole,
  type SsoConnection,
  type SsoDomain,
} from "./store.ts";
import { microsoftTenantOfSession } from "./auth-plugin.ts";
import { getPlatform } from "../platform.ts";

/** Binding a tenant reads the owner's own Microsoft sign-in, made for that purpose: a recent one. */
const LINK_SIGN_IN_MAX_AGE_MS = 15 * 60 * 1000;

export interface Actor {
  orgId: string;
  userId: string;
  orgRole: string;
  authMethod: string;
  /** The session behind a cookie-authenticated request. */
  sessionId?: string;
  /** Records one audit row for this request. */
  audit(entry: {
    action: string;
    before?: AuditPayload | null;
    after?: AuditPayload | null;
  }): Promise<void>;
}

/** Owners only, from the dashboard (RBAC spec §3.2): never an API key, OAuth client, MCP or CLI token. */
function assertOwnerSession(actor: Actor): void {
  if (actor.authMethod !== "session") {
    throw new ApiError({
      status: 403,
      code: "dashboard_session_required",
      title: "Forbidden",
      detail: "Enterprise sign-in settings can only be changed from a dashboard session.",
    });
  }
  if (actor.orgRole !== "owner") {
    throw forbidden("Only an owner of the organization can change enterprise sign-in.");
  }
}

export interface SsoSettings {
  connection: SsoConnection | null;
  domains: SsoDomain[];
  /** The tenant of the caller's own session, when a Microsoft sign-in opened it. */
  callerTenantId: string | null;
}

export async function readSettings(
  orgId: string,
  caller: { userId: string; sessionId?: string },
): Promise<SsoSettings> {
  const [connection, domains, callerSession] = await Promise.all([
    getConnection(orgId),
    listDomains(orgId),
    microsoftTenantOfSession(caller.sessionId, caller.userId),
  ]);
  return { connection, domains, callerTenantId: callerSession?.tenantId ?? null };
}

function auditView(connection: SsoConnection | null): AuditPayload {
  return {
    tenantId: connection?.tenantId ?? null,
    joinRole: connection?.joinRole ?? "member",
    enforced: connection?.enforcedAt != null,
  };
}

function microsoftSessionRequired(detail: string): ApiError {
  return conflict("microsoft_session_required", detail);
}

/** Bind the tenant of the owner's own, recent Microsoft sign-in. Never a typed value. */
export async function linkTenant(actor: Actor): Promise<void> {
  assertOwnerSession(actor);
  const origin = await microsoftTenantOfSession(actor.sessionId, actor.userId);
  if (!origin || Date.now() - origin.createdAt.getTime() > LINK_SIGN_IN_MAX_AGE_MS) {
    throw microsoftSessionRequired(
      "Sign in with Microsoft with your work account, then connect the tenant within 15 minutes.",
    );
  }
  const before = await getConnection(actor.orgId);
  if (before?.tenantId === origin.tenantId) return;
  if (before?.enforcedAt) {
    throw conflict("sso_enforced", "Lift the enforcement before binding another tenant.");
  }
  await saveConnection(actor.orgId, {
    tenantId: origin.tenantId,
    tenantLinkedBy: actor.userId,
    tenantLinkedAt: new Date(),
  });
  await actor.audit({
    action: "org_sso.tenant_linked",
    before: auditView(before),
    after: auditView(await getConnection(actor.orgId)),
  });
}

export async function unlinkTenant(actor: Actor): Promise<void> {
  assertOwnerSession(actor);
  const before = await getConnection(actor.orgId);
  if (!before?.tenantId) return;
  if (before.enforcedAt) {
    throw conflict("sso_enforced", "Lift the enforcement before unlinking the tenant.");
  }
  await saveConnection(actor.orgId, { tenantId: null, tenantLinkedBy: null, tenantLinkedAt: null });
  await actor.audit({
    action: "org_sso.tenant_unlinked",
    before: auditView(before),
    after: auditView(await getConnection(actor.orgId)),
  });
}

export async function setJoinRole(actor: Actor, joinRole: JoinRole): Promise<void> {
  assertOwnerSession(actor);
  const before = await getConnection(actor.orgId);
  if ((before?.joinRole ?? "member") === joinRole) return;
  await saveConnection(actor.orgId, { joinRole });
  await actor.audit({
    action: "org_sso.join_role_updated",
    before: auditView(before),
    after: auditView(await getConnection(actor.orgId)),
  });
}

export async function addDomain(actor: Actor, input: string): Promise<SsoDomain> {
  assertOwnerSession(actor);
  const domain = normalizeDomain(input);
  if (!domain) {
    throw new ApiError({
      status: 400,
      code: "invalid_domain",
      title: "Invalid Request",
      detail: "Enter a domain such as example.com.",
      param: "domain",
    });
  }
  const owner = await verifiedOwnerOf(domain);
  if (owner && owner !== actor.orgId) {
    throw conflict("domain_taken", "Another organization has already verified this domain.");
  }
  const created = await insertDomain(actor.orgId, domain, newVerificationToken());
  if (!created) throw conflict("domain_exists", "This domain is already listed.");
  await actor.audit({ action: "org_sso.domain_added", after: { domain } });
  return created;
}

/** Look up the TXT record; mark the domain verified when it carries the token. */
export async function verifyDomain(
  actor: Actor,
  domainId: string,
  resolveTxt?: TxtResolver,
): Promise<SsoDomain> {
  assertOwnerSession(actor);
  const domain = await getDomain(actor.orgId, domainId);
  if (!domain) throw notFound("Domain not found");
  if (domain.verifiedAt) return domain;
  let found: boolean;
  try {
    found = await hasVerificationRecord(domain.domain, domain.verificationToken, resolveTxt);
  } catch (cause) {
    throw new ApiError({
      status: 502,
      code: "dns_lookup_failed",
      title: "Bad Gateway",
      detail: "The DNS lookup failed. Try again in a few minutes.",
      cause,
    });
  }
  if (!found) {
    throw new ApiError({
      status: 422,
      code: "domain_not_verified",
      title: "Unprocessable Content",
      detail: `No TXT record ${verificationRecordName(domain.domain)} with the expected value was found.`,
    });
  }
  if (!(await markDomainVerified(domain.id, new Date()))) {
    throw conflict("domain_taken", "Another organization has already verified this domain.");
  }
  await actor.audit({ action: "org_sso.domain_verified", after: { domain: domain.domain } });
  return (await getDomain(actor.orgId, domainId))!;
}

export async function removeDomain(actor: Actor, domainId: string): Promise<void> {
  assertOwnerSession(actor);
  const domain = await getDomain(actor.orgId, domainId);
  if (!domain) throw notFound("Domain not found");
  if (domain.verifiedAt && (await getConnection(actor.orgId))?.enforcedAt) {
    throw conflict("sso_enforced", "Lift the enforcement before removing a verified domain.");
  }
  await deleteDomain(actor.orgId, domainId);
  await actor.audit({
    action: "org_sso.domain_removed",
    before: { domain: domain.domain, verified: domain.verifiedAt !== null },
  });
}

/**
 * Enforce Microsoft sign-in for the organization's verified domains. Allowed
 * only from a session the bound tenant opened, so the owner enforcing it has
 * just proven the way in still works. Every other session of the domains'
 * accounts ends, so each one comes back through Microsoft.
 */
export async function enforce(actor: Actor): Promise<{ endedAccounts: number }> {
  assertOwnerSession(actor);
  const before = await getConnection(actor.orgId);
  if (!before?.tenantId) {
    throw conflict("sso_not_ready", "Connect the organization's Microsoft tenant first.");
  }
  const verified = (await listDomains(actor.orgId)).filter((d) => d.verifiedAt);
  if (verified.length === 0) {
    throw conflict("sso_not_ready", "Verify at least one domain first.");
  }
  const origin = await microsoftTenantOfSession(actor.sessionId, actor.userId);
  if (origin?.tenantId !== before.tenantId) {
    throw microsoftSessionRequired(
      "Sign in with Microsoft from the organization's tenant before enforcing it, so that you cannot lock yourself out.",
    );
  }
  if (before.enforcedAt) return { endedAccounts: 0 };
  await saveConnection(actor.orgId, { enforcedAt: new Date(), enforcedBy: actor.userId });
  let endedAccounts = 0;
  for (const { domain } of verified) {
    endedAccounts += await getPlatform().services.sessions.endForEmailDomain(
      domain,
      actor.sessionId ?? null,
    );
  }
  await actor.audit({
    action: "org_sso.enforced",
    before: auditView(before),
    after: {
      ...auditView(await getConnection(actor.orgId)),
      domains: verified.map((d) => d.domain),
      endedAccounts,
    },
  });
  return { endedAccounts };
}

/** Lift enforcement: passwords and other linked sign-ins work again (none was deleted). */
export async function liftEnforcement(actor: Actor): Promise<void> {
  assertOwnerSession(actor);
  const before = await getConnection(actor.orgId);
  if (!before?.enforcedAt) return;
  await saveConnection(actor.orgId, { enforcedAt: null, enforcedBy: null });
  await actor.audit({
    action: "org_sso.enforcement_lifted",
    before: auditView(before),
    after: auditView(await getConnection(actor.orgId)),
  });
}
