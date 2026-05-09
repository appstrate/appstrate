// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgSystemProviderKeys } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getSystemModelProviderKeys } from "./model-registry.ts";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import { testModelConfig } from "./org-models.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { toISO, toISORequired } from "../lib/date-helpers.ts";

// --- List (system + DB) ---

export async function listOrgModelProviderKeys(orgId: string): Promise<OrgModelProviderKeyInfo[]> {
  const system = getSystemModelProviderKeys();
  const rows = await db
    .select()
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId }));
  const now = toISORequired(new Date());

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def): OrgModelProviderKeyInfo => ({
      id,
      label: def.label,
      api: def.api,
      baseUrl: def.baseUrl,
      source: "built-in",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (r) => ({
      id: r.id,
      label: r.label,
      api: r.api,
      baseUrl: r.baseUrl,
      source: "custom",
      createdBy: r.createdBy,
      createdAt: toISO(r.createdAt) ?? now,
      updatedAt: toISO(r.updatedAt) ?? now,
    }),
  });
}

// --- CRUD ---

export async function createOrgModelProviderKey(
  orgId: string,
  label: string,
  api: string,
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<string> {
  const [row] = await db
    .insert(orgSystemProviderKeys)
    .values({
      orgId,
      label,
      api,
      baseUrl,
      apiKeyEncrypted: encrypt(apiKey),
      createdBy: userId,
    })
    .returning({ id: orgSystemProviderKeys.id });
  return row!.id;
}

export async function updateOrgModelProviderKey(
  orgId: string,
  id: string,
  data: { label?: string; api?: string; baseUrl?: string; apiKey?: string },
): Promise<void> {
  const { apiKey, ...rest } = data;
  const updates = buildUpdateSet(rest);
  if (apiKey !== undefined) updates.apiKeyEncrypted = encrypt(apiKey);
  await db
    .update(orgSystemProviderKeys)
    .set(updates)
    .where(
      scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }),
    );
}

export async function deleteOrgModelProviderKey(orgId: string, id: string): Promise<void> {
  await db
    .delete(orgSystemProviderKeys)
    .where(
      scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }),
    );
}

// --- Credential loading ---

export async function loadModelProviderKeyCredentials(
  orgId: string,
  id: string,
): Promise<{ api: string; baseUrl: string; apiKey: string } | null> {
  // Check system model provider keys first (same pattern as loadModel checks system models)
  const systemKey = getSystemModelProviderKeys().get(id);
  if (systemKey) {
    return { api: systemKey.api, baseUrl: systemKey.baseUrl, apiKey: systemKey.apiKey };
  }

  const [row] = await db
    .select({
      api: orgSystemProviderKeys.api,
      baseUrl: orgSystemProviderKeys.baseUrl,
      apiKeyEncrypted: orgSystemProviderKeys.apiKeyEncrypted,
    })
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }))
    .limit(1);
  if (!row) return null;
  try {
    return { api: row.api, baseUrl: row.baseUrl, apiKey: decrypt(row.apiKeyEncrypted) };
  } catch {
    return null;
  }
}

// --- Connection test ---

export async function testModelProviderKeyConnection(
  orgId: string,
  id: string,
): Promise<TestResult> {
  const creds = await loadModelProviderKeyCredentials(orgId, id);
  if (!creds)
    return {
      ok: false,
      latency: 0,
      error: "KEY_NOT_FOUND",
      message: "Model provider key not found",
    };
  return testModelConfig({ ...creds, modelId: "_test" });
}
