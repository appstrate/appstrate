import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { orgProviderKeys } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getSystemProviderKeys } from "./model-registry.ts";
import type { OrgProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import { testModelConfig } from "./org-models.ts";

// --- List (system + DB) ---

export async function listOrgProviderKeys(orgId: string): Promise<OrgProviderKeyInfo[]> {
  const system = getSystemProviderKeys();
  const result: OrgProviderKeyInfo[] = [];

  // System provider keys first
  const now = new Date().toISOString();
  for (const [id, def] of system) {
    result.push({
      id,
      label: def.label,
      api: def.api,
      baseUrl: def.baseUrl,
      source: "built-in",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // DB provider keys
  const rows = await db.select().from(orgProviderKeys).where(eq(orgProviderKeys.orgId, orgId));
  for (const r of rows) {
    if (system.has(r.id)) continue;
    result.push({
      id: r.id,
      label: r.label,
      api: r.api,
      baseUrl: r.baseUrl,
      source: "custom",
      createdBy: r.createdBy,
      createdAt: r.createdAt?.toISOString() ?? now,
      updatedAt: r.updatedAt?.toISOString() ?? now,
    });
  }

  return result;
}

// --- CRUD ---

export async function createOrgProviderKey(
  orgId: string,
  label: string,
  api: string,
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<string> {
  const [row] = await db
    .insert(orgProviderKeys)
    .values({
      orgId,
      label,
      api,
      baseUrl,
      apiKeyEncrypted: encrypt(apiKey),
      createdBy: userId,
    })
    .returning({ id: orgProviderKeys.id });
  return row!.id;
}

export async function updateOrgProviderKey(
  orgId: string,
  id: string,
  data: { label?: string; api?: string; baseUrl?: string; apiKey?: string },
): Promise<void> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.label !== undefined) updates.label = data.label;
  if (data.api !== undefined) updates.api = data.api;
  if (data.baseUrl !== undefined) updates.baseUrl = data.baseUrl;
  if (data.apiKey !== undefined) updates.apiKeyEncrypted = encrypt(data.apiKey);
  await db
    .update(orgProviderKeys)
    .set(updates)
    .where(and(eq(orgProviderKeys.id, id), eq(orgProviderKeys.orgId, orgId)));
}

export async function deleteOrgProviderKey(orgId: string, id: string): Promise<void> {
  await db
    .delete(orgProviderKeys)
    .where(and(eq(orgProviderKeys.id, id), eq(orgProviderKeys.orgId, orgId)));
}

// --- Credential loading ---

export async function loadProviderKeyCredentials(
  orgId: string,
  id: string,
): Promise<{ api: string; baseUrl: string; apiKey: string } | null> {
  // Check system provider keys first (same pattern as loadModel checks system models)
  const systemKey = getSystemProviderKeys().get(id);
  if (systemKey) {
    return { api: systemKey.api, baseUrl: systemKey.baseUrl, apiKey: systemKey.apiKey };
  }

  const [row] = await db
    .select({
      api: orgProviderKeys.api,
      baseUrl: orgProviderKeys.baseUrl,
      apiKeyEncrypted: orgProviderKeys.apiKeyEncrypted,
    })
    .from(orgProviderKeys)
    .where(and(eq(orgProviderKeys.id, id), eq(orgProviderKeys.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  try {
    return { api: row.api, baseUrl: row.baseUrl, apiKey: decrypt(row.apiKeyEncrypted) };
  } catch {
    return null;
  }
}

// --- Connection test ---

export async function testProviderKeyConnection(orgId: string, id: string): Promise<TestResult> {
  const creds = await loadProviderKeyCredentials(orgId, id);
  if (!creds)
    return { ok: false, latency: 0, error: "KEY_NOT_FOUND", message: "Provider key not found" };
  return testModelConfig({ ...creds, modelId: "_test" });
}
