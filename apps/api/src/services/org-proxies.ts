import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { orgProxies } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getBuiltInProxies, isBuiltInProxy } from "./proxy-registry.ts";
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

// --- List (built-in + DB) ---

export async function listOrgProxies(orgId: string): Promise<OrgProxyInfo[]> {
  const builtIn = getBuiltInProxies();
  const result: OrgProxyInfo[] = [];

  // DB proxies for this org
  const rows = await db.select().from(orgProxies).where(eq(orgProxies.orgId, orgId));

  // Check if org has its own default set
  const orgHasDefault = rows.some((r) => r.isDefault);

  // Built-in proxies first
  const now = new Date().toISOString();
  for (const [id, def] of builtIn) {
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

  // DB proxies (skip if ID conflicts with built-in)
  for (const row of rows) {
    if (builtIn.has(row.id)) continue;
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
  if (isBuiltInProxy(proxyId)) {
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
  if (isBuiltInProxy(proxyId)) {
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

  // Only DB proxies can be flagged — built-in defaults are handled by the resolution cascade
  if (!isBuiltInProxy(proxyId)) {
    await db
      .update(orgProxies)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)));
  }
}

// --- Resolution ---

export async function resolveProxyUrl(
  orgId: string,
  packageId: string,
  config?: Record<string, unknown>,
): Promise<string | null> {
  // 1. Check flow config for __proxyId
  const resolved = config ?? (await getPackageConfig(orgId, packageId));
  const proxyId = resolved.__proxyId as string | undefined | null;

  if (proxyId === "none") return null;

  if (proxyId) {
    // Load specific proxy
    const url = await loadProxyUrl(orgId, proxyId);
    if (url) return url;
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
      return decrypt(dbDefault.urlEncrypted);
    } catch {
      logger.warn("Failed to decrypt default proxy URL", { proxyId: dbDefault.id });
    }
  }

  // 3. Check built-in proxies for a default
  const builtIn = getBuiltInProxies();
  for (const [, def] of builtIn) {
    if (def.isDefault && def.enabled !== false) {
      return def.url;
    }
  }

  // 4. Fallback to PROXY_URL env var
  return getEnv().PROXY_URL ?? null;
}

async function loadProxyUrl(orgId: string, proxyId: string): Promise<string | null> {
  // Check built-in first
  const builtIn = getBuiltInProxies();
  const builtInDef = builtIn.get(proxyId);
  if (builtInDef) return builtInDef.url;

  // Check DB
  const [row] = await db
    .select({ urlEncrypted: orgProxies.urlEncrypted, enabled: orgProxies.enabled })
    .from(orgProxies)
    .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)))
    .limit(1);

  if (!row || !row.enabled) return null;

  try {
    return decrypt(row.urlEncrypted);
  } catch {
    logger.warn("Failed to decrypt proxy URL", { proxyId });
    return null;
  }
}
