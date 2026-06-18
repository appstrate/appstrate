// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgProxies, organizations } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getSystemProxies, isSystemProxy } from "./proxy-registry.ts";
import { logger } from "../lib/logger.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { OrgProxyInfo, TestResult } from "@appstrate/shared-types";
import { mergeSystemAndDb, buildUpdateSet, isUuid } from "../lib/db-helpers.ts";
import { notFound } from "../lib/errors.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";

// --- URL Masking ---

function maskProxyUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    const str = parsed.toString();
    // Truncate long URLs for display
    return str.length > 60 ? `${str.slice(0, 57)}...` : str;
  } catch {
    return rawUrl.slice(0, 20) + "...";
  }
}

// --- Default pointer (org-level) ---

/**
 * The org's default proxy id — a flat id naming a system proxy or an
 * `org_proxies.id` (UUID), or `null` when no explicit default is set (the
 * resolver then falls to the system-flagged proxy then `PROXY_URL`). Single
 * read path for the pointer so list/resolve agree. Mirrors `getDefaultModelId`.
 */
async function getDefaultProxyId(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ defaultProxyId: organizations.defaultProxyId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.defaultProxyId ?? null;
}

// --- List (system + DB) ---

export async function listOrgProxies(orgId: string): Promise<OrgProxyInfo[]> {
  const system = getSystemProxies();
  const rows = await db.select().from(orgProxies).where(eq(orgProxies.orgId, orgId));
  // The default is an org-level pointer: when set, exactly that id is the
  // default (system or custom); when null, the system-flagged proxy wins.
  const pointer = await getDefaultProxyId(orgId);
  const now = toISORequired(new Date());

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def) => ({
      id,
      label: def.label,
      urlPrefix: maskProxyUrl(def.url),
      enabled: def.enabled !== false,
      isDefault: pointer !== null ? id === pointer : def.isDefault === true,
      source: "built-in" as const,
      created_by: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row) => ({
      id: row.id,
      label: row.label,
      urlPrefix: maskProxyUrl(decrypt(row.urlEncrypted)),
      enabled: row.enabled,
      isDefault: pointer !== null && row.id === pointer,
      source: row.source as "custom" | "built-in",
      created_by: row.createdBy,
      createdAt: toISORequired(row.createdAt),
      updatedAt: toISORequired(row.updatedAt),
    }),
  });
}

// --- Single-item read (system + DB) ---

/**
 * Fetch a single proxy (built-in or custom) in the exact same shape as
 * {@link listOrgProxies} / the `GET` list serializer. Used by mutating
 * handlers to return the resulting resource without a follow-up GET.
 * Returns null if no proxy with that id is visible to the org.
 */
export async function getOrgProxy(orgId: string, proxyId: string): Promise<OrgProxyInfo | null> {
  const proxies = await listOrgProxies(orgId);
  return proxies.find((p) => p.id === proxyId) ?? null;
}

// --- CRUD (DB proxies only) ---

export async function createOrgProxy(
  orgId: string,
  label: string,
  url: string,
  userId: string,
): Promise<string> {
  if (isBlockedUrl(url)) throw new Error("URL targets a blocked network");
  const urlEncrypted = encrypt(url);
  return db.transaction(async (tx) => {
    // If this is the first proxy for the org, point the org default at it.
    const existing = await tx
      .select({ id: orgProxies.id })
      .from(orgProxies)
      .where(eq(orgProxies.orgId, orgId))
      .limit(1);
    const isFirst = existing.length === 0;

    const [row] = await tx
      .insert(orgProxies)
      .values({
        orgId,
        label,
        urlEncrypted,
        source: "custom",
        createdBy: userId,
      })
      .returning({ id: orgProxies.id });

    if (isFirst) {
      await tx
        .update(organizations)
        .set({ defaultProxyId: row!.id, updatedAt: new Date() })
        .where(eq(organizations.id, orgId));
    }
    return row!.id;
  });
}

export async function updateOrgProxy(
  orgId: string,
  proxyId: string,
  data: { label?: string; url?: string; enabled?: boolean },
): Promise<void> {
  if (isSystemProxy(proxyId)) {
    throw new Error("Cannot modify built-in proxy");
  }

  const { url, ...rest } = data;
  const updates = buildUpdateSet(rest);
  if (url !== undefined) {
    if (isBlockedUrl(url)) throw new Error("URL targets a blocked network");
    updates.urlEncrypted = encrypt(url);
  }

  await db
    .update(orgProxies)
    .set(updates)
    .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)));
}

export async function deleteOrgProxy(orgId: string, proxyId: string): Promise<void> {
  if (isSystemProxy(proxyId)) {
    throw new Error("Cannot delete built-in proxy");
  }
  await db.delete(orgProxies).where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)));
  // If the deleted proxy was the org default, clear the now-dangling pointer so
  // the resolver falls cleanly to the system cascade (no stale-id badge).
  await db
    .update(organizations)
    .set({ defaultProxyId: null, updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), eq(organizations.defaultProxyId, proxyId)));
}

/**
 * Set (or clear, with `null`) the org's default proxy. The id may name a system
 * proxy OR one of the org's own rows — picking any row makes exactly that row the
 * default (the `setDefaultModel` analogue). An unknown custom id is rejected,
 * never stored. A single pointer write — no per-row flag flip.
 */
export async function setDefaultProxy(orgId: string, proxyId: string | null): Promise<void> {
  // Validate the target before storing it (mirrors setDefaultModel). A system id
  // is trusted via the registry; a custom id must be a row the org owns.
  if (proxyId !== null && !isSystemProxy(proxyId)) {
    // A non-UUID id can't be a custom row PK — reject without hitting the
    // `uuid` column (which would raise 22P02 → 500 instead of a clean 404).
    const [row] = isUuid(proxyId)
      ? await db
          .select({ id: orgProxies.id })
          .from(orgProxies)
          .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)))
          .limit(1)
      : [];
    if (!row) throw notFound(`Proxy '${proxyId}' not found`);
  }
  await db
    .update(organizations)
    .set({ defaultProxyId: proxyId, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
}

// --- Resolution ---

export async function resolveProxy(
  orgId: string,
  packageId: string,
  proxyId: string | null,
): Promise<{ url: string; label: string } | null> {
  // 1. Explicit override (agent column or per-run)
  if (proxyId === "none") return null;
  if (proxyId) {
    const result = await loadProxy(orgId, proxyId);
    if (result) return result;
    logger.warn("Agent proxy override not found, falling through to org default", {
      packageId,
      proxyId,
    });
  }

  // 2. Org default — the pointer names a system proxy or a custom row; load it
  //    directly (loadProxy handles system lookup, enabled check, and decrypt). A
  //    stale pointer (deleted/disabled row) resolves to null and falls through to
  //    the system cascade.
  const pointer = await getDefaultProxyId(orgId);
  if (pointer) {
    const resolved = await loadProxy(orgId, pointer);
    if (resolved) return resolved;
  }

  // 3. System default
  const system = getSystemProxies();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return { url: def.url, label: def.label };
    }
  }

  // 4. PROXY_URL env var fallback
  const envUrl = getEnv().PROXY_URL;
  return envUrl ? { url: envUrl, label: "Proxy" } : null;
}

export async function loadProxy(
  orgId: string,
  proxyId: string,
): Promise<{ url: string; label: string } | null> {
  // Check system proxies first
  const system = getSystemProxies();
  const systemDef = system.get(proxyId);
  if (systemDef) return { url: systemDef.url, label: systemDef.label };

  // Check DB
  const [row] = await db
    .select({
      urlEncrypted: orgProxies.urlEncrypted,
      enabled: orgProxies.enabled,
      label: orgProxies.label,
    })
    .from(orgProxies)
    .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)))
    .limit(1);

  if (!row || !row.enabled) return null;

  try {
    return { url: decrypt(row.urlEncrypted), label: row.label };
  } catch {
    logger.warn("Failed to decrypt proxy URL", { proxyId });
    return null;
  }
}

// --- Connection test ---

export async function testProxyConnection(orgId: string, proxyId: string): Promise<TestResult> {
  const proxy = await loadProxy(orgId, proxyId);
  if (!proxy) {
    return { ok: false, latency: 0, error: "PROXY_NOT_FOUND", message: "Proxy not found" };
  }

  if (isBlockedUrl(proxy.url)) {
    return {
      ok: false,
      latency: 0,
      error: "BLOCKED_URL",
      message: "URL targets a blocked network",
    };
  }

  const start = performance.now();
  try {
    const res = await fetch("https://cloudflare.com/cdn-cgi/trace", {
      proxy: proxy.url,
      signal: AbortSignal.timeout(10_000),
    } as RequestInit);
    const latency = Math.round(performance.now() - start);

    if (res.ok) return { ok: true, latency };
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Proxy returned ${res.status}`,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}
