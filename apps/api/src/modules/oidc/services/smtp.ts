// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application SMTP: resolver + admin CRUD + test-send helper.
 *
 * Resolver:
 *  - `level=application` → reads `application_smtp_configs` for the referenced
 *    app. Absent → `null` (email features disabled, no fallback to env SMTP).
 *  - `level=org` / `level=instance` → falls back to the env SMTP transport
 *    managed by `@appstrate/db/auth`. Still `null` when env SMTP is absent.
 *
 * Admin:
 *  - CRUD on the same row, keyed by `applicationId`.
 *  - Views never expose the password column (`SmtpConfigView` omits it by
 *    construction).
 *  - Mutations invalidate the resolver cache so admins see changes within
 *    one request.
 *
 * Rotation:
 *  - Ciphertexts are self-describing `v1:<kid>:` envelopes (`@appstrate/connect`).
 *    Key rotation rides the connect keyring: rotate `CONNECTION_ENCRYPTION_KEY`
 *    / `CONNECTION_ENCRYPTION_KEY_ID` and keep the retired key in
 *    `CONNECTION_ENCRYPTION_KEYS` — old rows keep decrypting, new writes embed
 *    the active kid. A row whose kid is no longer in the keyring fails
 *    decryption and surfaces as "not configured" instead of throwing.
 *
 * Test hook: when `row.host === "__test_json__"`, a nodemailer `jsonTransport`
 * is returned. Mirrors the instance-level behavior in `packages/db/src/auth.ts`.
 */

import { createTransport, type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import { resolveAndCheckHost } from "@appstrate/core/ssrf";
import { getEnv } from "@appstrate/env";
import type { SmtpConfigView } from "@appstrate/shared-types";
import { applicationSmtpConfigs } from "@appstrate/db/schema";
import type { OAuthClientRecord } from "./oauth-admin.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { logger } from "../../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface ResolvedSmtpConfig {
  transport: Transporter;
  fromAddress: string;
  fromName: string | null;
  source: "per-app" | "instance";
}

export type { SmtpConfigView };

export interface UpsertSmtpConfigInput {
  host: string;
  port: number;
  username: string;
  pass: string;
  fromAddress: string;
  fromName?: string | null;
  secureMode?: "auto" | "tls" | "starttls" | "none";
}

const INSTANCE_CACHE_KEY = "__instance__";
const cache = createTtlCache<ResolvedSmtpConfig>("oidc:smtp-cache-invalidate");

export interface SpiedSmtpSend {
  source: "per-app" | "instance";
  to: string;
  from: string;
  subject: string;
}
let smtpSpy: ((e: SpiedSmtpSend) => void) | null = null;
export function _setSmtpSpy(fn: ((e: SpiedSmtpSend) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("_setSmtpSpy is test-only");
  smtpSpy = fn;
}

function wrapForSpy(transport: Transporter, source: "per-app" | "instance"): Transporter {
  const originalSendMail = transport.sendMail.bind(transport);
  transport.sendMail = async (mail: Parameters<Transporter["sendMail"]>[0]) => {
    const result = await originalSendMail(mail);
    if (smtpSpy) {
      const to = Array.isArray(mail.to) ? mail.to.join(",") : String(mail.to ?? "");
      const from = typeof mail.from === "string" ? mail.from : String(mail.from ?? "");
      smtpSpy({ source, to, from, subject: String(mail.subject ?? "") });
    }
    return result;
  };
  return transport;
}

function resolveSecure(mode: "auto" | "tls" | "starttls" | "none", port: number): boolean {
  if (mode === "tls") return true;
  if (mode === "starttls" || mode === "none") return false;
  return port === 465;
}

type SmtpRow = typeof applicationSmtpConfigs.$inferSelect;

// CASING: `SmtpConfigView` is wire-facing (returned by the admin SMTP-config
// routes) but carries camelCase members (`fromAddress`, `fromName`,
// `secureMode`) where the snake_case wire convention would want
// `from_address` / `from_name` / `secure_mode`. `applicationId`, `createdAt`,
// `updatedAt` are legitimate universal-field carve-outs; the three others are
// a genuine drift. NOT fixed here: the shape is defined by `SmtpConfigView` in
// `@appstrate/shared-types` (outside this module) and consumed by the SPA, so
// renaming is a coordinated wire-breaking change, not a local edit. Tracked
// note only — see docs/CASING_CONVENTIONS.md.
function mapRow(row: SmtpRow): SmtpConfigView {
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

async function buildTransport(row: SmtpRow): Promise<Transporter | null> {
  if (row.host === "__test_json__") {
    return createTransport({ jsonTransport: true });
  }
  let pass: string;
  try {
    pass = decryptCredentials<{ pass: string }>(row.passEncrypted).pass;
  } catch (err) {
    logger.error("oidc smtp: decryption failed for per-app config, treating as unconfigured", {
      applicationId: row.applicationId,
      error: getErrorMessage(err),
    });
    return null;
  }
  // SSRF hardening (connect-time, fail-closed). `isBlockedHost` at config-write
  // time is a LITERAL check only — a public DNS name whose A/AAAA record points
  // at loopback / a metadata IP / an internal range sails through it, and
  // nodemailer would otherwise re-resolve the raw hostname itself at connect
  // time (DNS-rebind window). Resolve the host NOW, refuse anything that lands
  // in a blocked range or cannot be resolved, and pin the socket to the vetted
  // IP so nodemailer connects to that address rather than re-resolving the
  // name. `tls.servername` preserves the original hostname for SNI + TLS
  // certificate validation (both the implicit-TLS `secure:true` and the
  // STARTTLS upgrade paths honour it), so pinning to an IP does not break cert
  // verification. The transport is cached (see `resolvePerAppSmtp`), so the pin
  // holds for every send until the cache entry is evicted — a name repointed
  // after resolution cannot redirect an already-built transport. Residual: the
  // gap between resolving here and the first TCP connect is not zero, but the
  // socket targets the pinned IP, so a rebind cannot steer it to a fresh,
  // unvetted address.
  const hostCheck = await resolveAndCheckHost(row.host);
  if (hostCheck.blocked) {
    logger.error("oidc smtp: host failed SSRF check, treating as unconfigured", {
      applicationId: row.applicationId,
      host: row.host,
      reason: hostCheck.reason,
    });
    return null;
  }
  return createTransport({
    host: hostCheck.pinnedAddress,
    port: row.port,
    secure: resolveSecure(row.secureMode, row.port),
    auth: { user: row.username, pass },
    tls: { servername: row.host },
  });
}

async function resolvePerAppSmtp(applicationId: string): Promise<ResolvedSmtpConfig | null> {
  return cache.getOrLoad(applicationId, async () => {
    const [row] = await db
      .select()
      .from(applicationSmtpConfigs)
      .where(eq(applicationSmtpConfigs.applicationId, applicationId))
      .limit(1);
    if (!row) return null;
    const transport = await buildTransport(row);
    if (!transport) return null;
    return {
      transport: wrapForSpy(transport, "per-app"),
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      source: "per-app",
    };
  });
}

function resolveInstanceSmtp(): ResolvedSmtpConfig | null {
  const cached = cache.get(INSTANCE_CACHE_KEY);
  if (cached !== undefined) return cached;

  const env = getEnv();
  const enabled = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
  if (!enabled) {
    cache.set(INSTANCE_CACHE_KEY, null);
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
  cache.set(INSTANCE_CACHE_KEY, value);
  return value;
}

/** Resolve the SMTP transport for an OIDC flow. Returns `null` when unconfigured. */
export async function resolveSmtpForClient(
  client: Pick<OAuthClientRecord, "level" | "referencedApplicationId">,
): Promise<ResolvedSmtpConfig | null> {
  if (client.level === "application") {
    if (!client.referencedApplicationId) return null;
    return resolvePerAppSmtp(client.referencedApplicationId);
  }
  return resolveInstanceSmtp();
}

/** Evict the cached per-app transport (call on upsert/delete). Publishes to pub/sub. */
export async function invalidateSmtpCache(applicationId: string): Promise<void> {
  await cache.delete(applicationId);
}

/** Test-only: clear the entire cache. */
export function _clearSmtpCacheForTesting(): void {
  cache.clearForTesting();
}

// ───────────────────────── Admin CRUD ─────────────────────────

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

/** Send a test email via the persisted config. Errors are re-raised verbatim. */
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
