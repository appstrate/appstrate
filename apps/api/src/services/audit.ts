/**
 * Audit trail — durable record of state-changing operations.
 *
 * Best-effort by design: a failed insert is logged and swallowed so the
 * caller's mutation never depends on audit health. The trade-off is that
 * an audit row is not a guarantee of state change (the mutation could
 * have committed and the insert could have lost), but a state change is
 * never blocked by audit logging.
 *
 * Callers pass a typed `RecordAuditInput`. Most fields are optional so
 * the helper can be added to existing routes without restructuring
 * argument plumbing.
 */

import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { auditEvents } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "../types/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export type AuditActorType = "user" | "end_user" | "api_key" | "system" | (string & {});

export interface RecordAuditInput {
  orgId: string;
  applicationId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  /** Verb scoped by resource — `connection.created`, `api_key.revoked`, … */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      orgId: input.orgId,
      applicationId: input.applicationId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });
  } catch (err) {
    logger.error("recordAudit failed (state change is unaffected)", {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Convenience wrapper: derive `actorType`, `actorId`, `ip`, `userAgent`,
 * `requestId`, and `applicationId` from the Hono context. Routes still
 * pass the audit-specific fields (`action`, `resourceType`, …).
 */
export async function recordAuditFromContext(
  c: Context<AppEnv>,
  input: Omit<
    RecordAuditInput,
    "orgId" | "applicationId" | "actorType" | "actorId" | "ip" | "userAgent" | "requestId"
  >,
): Promise<void> {
  const orgId = c.get("orgId");
  if (!orgId) return;

  const user = c.get("user");
  const apiKeyId = c.get("apiKeyId");
  const endUser = c.get("endUser");

  let actorType: AuditActorType = "system";
  let actorId: string | null = null;
  if (apiKeyId) {
    actorType = "api_key";
    actorId = apiKeyId;
  } else if (endUser) {
    actorType = "end_user";
    actorId = endUser.id;
  } else if (user) {
    actorType = "user";
    actorId = user.id;
  }

  await recordAudit({
    ...input,
    orgId,
    applicationId: c.get("applicationId") ?? null,
    actorType,
    actorId,
    ip: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}
