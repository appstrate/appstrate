// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application SMTP resolver.
 *
 * Given an OAuth client, returns the SMTP transport the OIDC flows should use
 * for this request:
 *  - `level=application` → reads `application_smtp_configs` for the referenced
 *    app. If absent, returns `null` (email features disabled for this flow).
 *    No fallback to instance-level env SMTP.
 *  - `level=org` / `level=instance` → falls back to the instance-level env
 *    SMTP transport managed by `@appstrate/db/auth`. When env SMTP is absent
 *    too, returns `null`.
 *
 * Transports are cached by applicationId with a short TTL. Null entries are
 * cached too (shorter TTL) so a freshly-configured admin sees changes quickly
 * without hammering the DB on every login page render. `invalidateSmtpCache()`
 * is called by the admin routes on upsert/delete.
 *
 * Test hook: when `row.host === "__test_json__"`, a nodemailer `jsonTransport`
 * is returned instead of a real SMTP connection. Mirrors the instance-level
 * behavior in `packages/db/src/auth.ts`.
 */

import { createTransport, type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { decryptCredentials } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { applicationSmtpConfigs } from "../schema.ts";
import type { OAuthClientRecord } from "./oauth-admin.ts";

export interface ResolvedSmtpConfig {
  transport: Transporter;
  fromAddress: string;
  fromName: string | null;
  source: "per-app" | "instance";
}

interface CacheEntry {
  value: ResolvedSmtpConfig | null;
  expiresAt: number;
}

const PER_APP_TTL_MS = 60_000;
const NULL_TTL_MS = 30_000;
const INSTANCE_CACHE_KEY = "__instance__";

const cache = new Map<string, CacheEntry>();

/**
 * Test-only mail spy. When set, every transport built by the resolver is
 * wrapped so its `sendMail` invocations are recorded with the resolver
 * source tag (per-app vs instance). Used by E2E tests to assert how many
 * mails were sent and via which SMTP path.
 */
export interface SpiedMail {
  source: "per-app" | "instance";
  to: string;
  from: string;
  subject: string;
}
let testMailSpy: ((mail: SpiedMail) => void) | null = null;
export function _setTestMailSpy(fn: ((mail: SpiedMail) => void) | null): void {
  testMailSpy = fn;
}

function wrapForSpy(transport: Transporter, source: "per-app" | "instance"): Transporter {
  const originalSendMail = transport.sendMail.bind(transport);
  transport.sendMail = async (mail: Parameters<Transporter["sendMail"]>[0]) => {
    const result = await originalSendMail(mail);
    if (testMailSpy) {
      const to = Array.isArray(mail.to) ? mail.to.join(",") : String(mail.to ?? "");
      const from = typeof mail.from === "string" ? mail.from : String(mail.from ?? "");
      testMailSpy({ source, to, from, subject: String(mail.subject ?? "") });
    }
    return result;
  };
  return transport;
}

/** Decide the nodemailer `secure` flag from the admin-configured mode + port. */
function resolveSecure(mode: "auto" | "tls" | "starttls" | "none", port: number): boolean {
  if (mode === "tls") return true;
  if (mode === "starttls" || mode === "none") return false;
  // "auto": implicit TLS on 465, STARTTLS elsewhere.
  return port === 465;
}

function buildTransport(row: typeof applicationSmtpConfigs.$inferSelect): Transporter {
  if (row.host === "__test_json__") {
    return createTransport({ jsonTransport: true });
  }
  const pass = decryptCredentials<{ pass: string }>(row.passEncrypted).pass;
  return createTransport({
    host: row.host,
    port: row.port,
    secure: resolveSecure(row.secureMode, row.port),
    auth: { user: row.username, pass },
  });
}

async function resolvePerAppSmtp(applicationId: string): Promise<ResolvedSmtpConfig | null> {
  const now = Date.now();
  const cached = cache.get(applicationId);
  if (cached && cached.expiresAt > now) return cached.value;

  const [row] = await db
    .select()
    .from(applicationSmtpConfigs)
    .where(eq(applicationSmtpConfigs.applicationId, applicationId))
    .limit(1);

  if (!row) {
    cache.set(applicationId, { value: null, expiresAt: now + NULL_TTL_MS });
    return null;
  }

  const value: ResolvedSmtpConfig = {
    transport: wrapForSpy(buildTransport(row), "per-app"),
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    source: "per-app",
  };
  cache.set(applicationId, { value, expiresAt: now + PER_APP_TTL_MS });
  return value;
}

function resolveInstanceSmtp(): ResolvedSmtpConfig | null {
  const now = Date.now();
  const cached = cache.get(INSTANCE_CACHE_KEY);
  if (cached && cached.expiresAt > now) return cached.value;

  const env = getEnv();
  const enabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
  if (!enabled) {
    cache.set(INSTANCE_CACHE_KEY, { value: null, expiresAt: now + NULL_TTL_MS });
    return null;
  }

  const transport =
    env.SMTP_HOST === "__test_json__"
      ? createTransport({ jsonTransport: true })
      : createTransport({
          host: env.SMTP_HOST!,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
        });

  const value: ResolvedSmtpConfig = {
    transport: wrapForSpy(transport, "instance"),
    fromAddress: env.SMTP_FROM!,
    fromName: null,
    source: "instance",
  };
  cache.set(INSTANCE_CACHE_KEY, { value, expiresAt: now + PER_APP_TTL_MS });
  return value;
}

/**
 * Resolve the SMTP transport to use for an OIDC flow driven by `client`.
 * Returns `null` when no transport is configured — callers must gate email
 * features accordingly (`features.smtp = !!result`).
 */
export async function resolveSmtpForClient(
  client: Pick<OAuthClientRecord, "level" | "referencedApplicationId">,
): Promise<ResolvedSmtpConfig | null> {
  if (client.level === "application") {
    if (!client.referencedApplicationId) return null;
    return resolvePerAppSmtp(client.referencedApplicationId);
  }
  return resolveInstanceSmtp();
}

/** Invalidate a cached per-app SMTP transport (call on upsert/delete). */
export function invalidateSmtpCache(applicationId: string): void {
  cache.delete(applicationId);
}

/** Test-only: clear the entire cache. Used by the resolver unit tests. */
export function _clearSmtpCacheForTesting(): void {
  cache.clear();
}
