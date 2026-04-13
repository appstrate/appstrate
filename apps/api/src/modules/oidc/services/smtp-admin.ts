// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application SMTP admin service.
 *
 * CRUD over `application_smtp_configs` + a rate-limited test-send helper.
 * Password column is never returned — `SmtpConfigView` omits it by construction.
 * Mutations always invalidate the resolver cache so the admin sees updates
 * within one request instead of waiting out the TTL.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { encryptCredentials } from "@appstrate/connect";
import { applicationSmtpConfigs } from "../schema.ts";
import { invalidateSmtpCache, resolveSmtpForClient } from "./smtp-config.ts";
import { CURRENT_ENCRYPTION_KEY_VERSION } from "./encryption-key-version.ts";

export interface SmtpConfigView {
  applicationId: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string | null;
  secureMode: "auto" | "tls" | "starttls" | "none";
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSmtpConfigInput {
  host: string;
  port: number;
  username: string;
  pass: string;
  fromAddress: string;
  fromName?: string | null;
  secureMode?: "auto" | "tls" | "starttls" | "none";
}

function mapRow(row: typeof applicationSmtpConfigs.$inferSelect): SmtpConfigView {
  return {
    applicationId: row.applicationId,
    host: row.host,
    port: row.port,
    username: row.username,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    secureMode: row.secureMode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSmtpConfig(applicationId: string): Promise<SmtpConfigView | null> {
  const [row] = await db
    .select()
    .from(applicationSmtpConfigs)
    .where(eq(applicationSmtpConfigs.applicationId, applicationId))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function upsertSmtpConfig(
  applicationId: string,
  input: UpsertSmtpConfigInput,
): Promise<SmtpConfigView> {
  const passEncrypted = encryptCredentials({ pass: input.pass });
  const now = new Date();
  const values = {
    applicationId,
    host: input.host,
    port: input.port,
    username: input.username,
    passEncrypted,
    encryptionKeyVersion: CURRENT_ENCRYPTION_KEY_VERSION,
    fromAddress: input.fromAddress,
    fromName: input.fromName ?? null,
    secureMode: input.secureMode ?? ("auto" as const),
    updatedAt: now,
  };
  const [row] = await db
    .insert(applicationSmtpConfigs)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: applicationSmtpConfigs.applicationId,
      set: values,
    })
    .returning();
  await invalidateSmtpCache(applicationId);
  return mapRow(row!);
}

export async function deleteSmtpConfig(applicationId: string): Promise<boolean> {
  const deleted = await db
    .delete(applicationSmtpConfigs)
    .where(eq(applicationSmtpConfigs.applicationId, applicationId))
    .returning({ id: applicationSmtpConfigs.applicationId });
  await invalidateSmtpCache(applicationId);
  return deleted.length > 0;
}

/**
 * Send a test email using the stored config. Uses the *persisted* row — admins
 * PUT first, then test. Returns nodemailer's `messageId` on success. Errors
 * from the SMTP server are re-raised so the admin route can surface them
 * verbatim (DKIM/SPF misalignment, auth failure, etc. need to reach the
 * operator).
 */
export async function sendTestEmail(
  applicationId: string,
  to: string,
): Promise<{ messageId: string }> {
  const resolved = await resolveSmtpForClient({
    level: "application",
    referencedApplicationId: applicationId,
  });
  if (!resolved) {
    throw new Error("SMTP configuration not found for this application");
  }

  const info = await resolved.transport.sendMail({
    from: resolved.fromName
      ? `"${resolved.fromName}" <${resolved.fromAddress}>`
      : resolved.fromAddress,
    to,
    subject: "Appstrate — Test SMTP",
    text:
      "This is a test email sent from your per-application SMTP configuration. " +
      "If you received it, your SMTP settings are correctly wired up.",
    html:
      "<p>This is a test email sent from your per-application SMTP configuration.</p>" +
      "<p>If you received it, your SMTP settings are correctly wired up.</p>",
  });

  return { messageId: info.messageId ?? "" };
}
