// SPDX-License-Identifier: Apache-2.0

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgProxies } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getSystemProxies, isSystemProxy } from "./proxy-registry.ts";
import { logger } from "../lib/logger.ts";
import { checkEgressUrl, isBlockedEgressUrl } from "../lib/egress-host-guard.ts";
import type { OrgProxyInfo, TestResult } from "@appstrate/shared-types";
import {
  mergeSystemAndDb,
  buildUpdateSet,
  createDefaultPointer,
  isInvalidTextRepresentation,
} from "../lib/db-helpers.ts";
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
 * The org's default proxy pointer — a flat id naming a system proxy or an
 * `org_proxies.id` (UUID), or `null` when no explicit default is set (the
 * resolver then falls to the system-flagged proxy then `PROXY_URL`). Single
 * read path for the pointer so list/resolve agree. The four pointer operations
 * (read, first-row promotion, set-default, dangling-clear) are the generic
 * `createDefaultPointer` helper — shared byte-for-byte with `org-models`.
 */
const defaultProxy = createDefaultPointer({
  table: orgProxies,
  pointerField: "defaultProxyId",
  isSystem: isSystemProxy,
  scopeWhere: (orgId, rowId) =>
    rowId !== undefined
      ? and(eq(orgProxies.id, rowId), eq(orgProxies.orgId, orgId))
      : eq(orgProxies.orgId, orgId),
  entityName: "Proxy",
});

// --- List (system + DB) ---

export async function listOrgProxies(orgId: string): Promise<OrgProxyInfo[]> {
  const system = getSystemProxies();
  const rows = await db.select().from(orgProxies).where(eq(orgProxies.orgId, orgId));
  // The default is an org-level pointer: when set, exactly that id is the
  // default (system or custom); when null, the system-flagged proxy wins.
  const pointer = await defaultProxy.getDefaultId(orgId);
  const now = toISORequired(new Date());

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def) => ({
      id,
      label: def.label,
      urlPrefix: maskProxyUrl(def.url),
      enabled: def.enabled !== false,
      is_default: pointer !== null ? id === pointer : def.isDefault === true,
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
      is_default: pointer !== null && row.id === pointer,
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
  if (isBlockedEgressUrl(url)) throw new Error("URL targets a blocked network");
  const urlEncrypted = encrypt(url);
  return db.transaction(async (tx) => {
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

    // If this is the first proxy for the org, point the org default at it.
    await defaultProxy.promoteIfFirst(tx, orgId, row!.id);
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
  // Keys of `updateProxySchema` (routes/proxies.ts) minus `url`, which is
  // encrypted below and stored as `urlEncrypted`.
  const updates = buildUpdateSet(rest, ["label", "enabled"]);
  if (url !== undefined) {
    if (isBlockedEgressUrl(url)) throw new Error("URL targets a blocked network");
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
  await defaultProxy.clearDanglingPointer(orgId, proxyId);
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
  await defaultProxy.setDefault(orgId, proxyId);
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
  const pointer = await defaultProxy.getDefaultId(orgId);
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

  // Check DB. `orgProxies.id` is a `uuid` column — a `proxyId` that isn't a
  // valid UUID makes Postgres raise `22P02 invalid_text_representation` rather
  // than returning no rows. Normalise that one cast failure into "not found"
  // (null) so callers see a clean miss instead of a 500; rethrow any other
  // error. Mirrors `loadModel` in org-models.
  let row: { urlEncrypted: string; enabled: boolean; label: string } | undefined;
  try {
    [row] = await db
      .select({
        urlEncrypted: orgProxies.urlEncrypted,
        enabled: orgProxies.enabled,
        label: orgProxies.label,
      })
      .from(orgProxies)
      .where(and(eq(orgProxies.id, proxyId), eq(orgProxies.orgId, orgId)))
      .limit(1);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return null;
    throw err;
  }

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

  // Canonical egress guard (parse + scheme floor + allowlist-aware literal +
  // DNS-rebind host gate) before we route a request through the proxy: a public
  // hostname resolving to a private/loopback/link-local address is refused,
  // fail-closed, with the same BLOCKED_URL result (the reason is never surfaced).
  const egress = await checkEgressUrl(proxy.url);
  if (!egress.ok) {
    return {
      ok: false,
      latency: 0,
      error: "BLOCKED_URL",
      message: "URL targets a blocked network",
    };
  }

  const start = performance.now();
  try {
    // ACCEPTED RESIDUAL — the proxy HOP is not pinned to `egress.pinnedAddress`.
    // Bun's `proxy:` option re-resolves the proxy hostname at connect time, so a
    // check-then-connect DNS-rebind window remains on the proxy hop (the same
    // TOCTOU `guardedFetch` closes for direct fetches — but `guardedFetch` does
    // not cover the `proxy:` transport). We deliberately do NOT rewrite
    // `proxy.url`'s host to the pinned address: for an `https://` proxy the TLS
    // handshake to the proxy would then run against the bare IP with no way to
    // set SNI/certificate identity for the PROXY hop (Bun's per-request `tls`
    // option applies to the origin request, not the proxy connection), breaking
    // every TLS proxy; pinning only `http://` proxies would be asymmetric,
    // unverified coverage. Exposure is low: the target URL is fixed
    // (cloudflare.com), no platform credential rides along (only the org's own
    // proxy userinfo, sent to a host whose DNS the same org controls), and the
    // worst case is delivering one fixed CONNECT/GET line to an internal
    // address the org rebinds to.
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
