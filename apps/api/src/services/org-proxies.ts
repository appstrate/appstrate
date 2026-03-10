import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { orgProxies } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getSystemProxies, isSystemProxy } from "./proxy-registry.ts";
import { getPackageConfig } from "./state.ts";
import { logger } from "../lib/logger.ts";
import type { OrgProxyInfo } from "@appstrate/shared-types";

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

// --- List (system + DB) ---

export async function listOrgProxies(orgId: string): Promise<OrgProxyInfo[]> {
  const system = getSystemProxies();
  const result: OrgProxyInfo[] = [];

  // DB proxies for this org
  const rows = await db.select().from(orgProxies).where(eq(orgProxies.orgId, orgId));

  // Check if org has its own default set
  const orgHasDefault = rows.some((r) => r.isDefault);

  // System proxies first
  const now = new Date().toISOString();
  for (const [id, def] of system) {
    result.push({
      id,
      label: def.label,
      urlPrefix: maskProxyUrl(def.url),
      enabled: def.enabled !== false,
      isDefault: !orgHasDefault && def.isDefault === true,
      source: "built-in",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // DB proxies (skip if ID conflicts with system proxy)
  for (const row of rows) {
    if (system.has(row.id)) continue;
    let urlPrefix: string;
    try {
      urlPrefix = maskProxyUrl(decrypt(row.urlEncrypted));
    } catch {
      urlPrefix = "***";
    }
    result.push({
      id: row.id,
      label: row.label,
      urlPrefix,
      enabled: row.enabled,
      isDefault: row.isDefault,
      source: row.source as "built-in" | "custom",
      createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
    });
  }

  return result;
}

// --- CRUD (DB proxies only) ---

export async function createOrgProxy(
  orgId: string,
  label: string,
  url: string,
  userId: string,
): Promise<string> {
  const urlEncrypted = encrypt(url);
  const [row] = await db
    .insert(orgProxies)
    .values({
      orgId,
      label,
      urlEncrypted,
      source: "custom",
      createdBy: userId,
    })
    .returning({ id: orgProxies.id });
  return row!.id;
}

export async function updateOrgProxy(
  orgId: string,
  proxyId: string,
  data: { label?: string; url?: string; enabled?: boolean },
): Promise<void> {
  if (isSystemProxy(proxyId)) {
    throw new Error("Cannot modify built-in proxy");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.label !== undefined) updates.label = data.label;
  if (data.url !== undefined) updates.urlEncrypted = encrypt(data.url);
  if (data.enabled !== undefined) updates.enabled = data.enabled;

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
}

export async function setDefaultProxy(orgId: string, proxyId: string | null): Promise<void> {
  // Reset all defaults for this org
  await db
    .update(orgProxies)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(orgProxies.orgId, orgId));

  if (proxyId === null) return;

  // Only DB proxies can be flagged — system defaults are handled by the resolution cascade
  if (!isSystemProxy(proxyId)) {
    await db
      .update(orgProxies)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)));
  }
}

// --- Resolution ---

export async function resolveProxy(
  orgId: string,
  packageId: string,
  config?: Record<string, unknown>,
): Promise<{ url: string; label: string } | null> {
  // 1. Check flow config for __proxyId
  const resolved = config ?? (await getPackageConfig(orgId, packageId));
  const proxyId = resolved.__proxyId as string | undefined | null;

  if (proxyId === "none") return null;

  if (proxyId) {
    // Load specific proxy
    const result = await loadProxy(orgId, proxyId);
    if (result) return result;
    logger.warn("Flow proxy override not found, falling through to org default", {
      packageId,
      proxyId,
    });
  }

  // 2. Find org default — check DB first
  const [dbDefault] = await db
    .select()
    .from(orgProxies)
    .where(
      and(
        eq(orgProxies.orgId, orgId),
        eq(orgProxies.isDefault, true),
        eq(orgProxies.enabled, true),
      ),
    )
    .limit(1);

  if (dbDefault) {
    try {
      return { url: decrypt(dbDefault.urlEncrypted), label: dbDefault.label };
    } catch {
      logger.warn("Failed to decrypt default proxy URL", { proxyId: dbDefault.id });
    }
  }

  // 3. Check system proxies for a default
  const system = getSystemProxies();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return { url: def.url, label: def.label };
    }
  }

  // 4. Fallback to PROXY_URL env var
  const envUrl = getEnv().PROXY_URL;
  return envUrl ? { url: envUrl, label: "Proxy" } : null;
}

async function loadProxy(
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
