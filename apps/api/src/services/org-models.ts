import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { orgModels } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import { getPackageConfig } from "./state.ts";
import { logger } from "../lib/logger.ts";
import type { OrgModelInfo } from "@appstrate/shared-types";

// --- List (system + DB) ---

export async function listOrgModels(orgId: string): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const result: OrgModelInfo[] = [];

  // DB models for this org
  const rows = await db.select().from(orgModels).where(eq(orgModels.orgId, orgId));

  // Check if org has its own default set
  const orgHasDefault = rows.some((r) => r.isDefault);

  // System models first
  const now = new Date().toISOString();
  for (const [id, def] of system) {
    result.push({
      id,
      label: def.label,
      api: def.api,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      input: def.input ?? null,
      contextWindow: def.contextWindow ?? null,
      maxTokens: def.maxTokens ?? null,
      reasoning: def.reasoning ?? null,
      enabled: def.enabled !== false,
      isDefault: !orgHasDefault && def.isDefault === true,
      source: "built-in",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // DB models (skip if ID conflicts with system model)
  for (const row of rows) {
    if (system.has(row.id)) continue;
    result.push({
      id: row.id,
      label: row.label,
      api: row.api,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      input: row.input as string[] | null,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
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

// --- CRUD (DB models only) ---

export async function createOrgModel(
  orgId: string,
  label: string,
  api: string,
  baseUrl: string,
  modelId: string,
  apiKey: string,
  userId: string,
  capabilities?: {
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  },
): Promise<string> {
  const apiKeyEncrypted = encrypt(apiKey);
  const [row] = await db
    .insert(orgModels)
    .values({
      orgId,
      label,
      api,
      baseUrl,
      modelId,
      apiKeyEncrypted,
      input: capabilities?.input ?? null,
      contextWindow: capabilities?.contextWindow ?? null,
      maxTokens: capabilities?.maxTokens ?? null,
      reasoning: capabilities?.reasoning ?? null,
      source: "custom",
      createdBy: userId,
    })
    .returning({ id: orgModels.id });
  return row!.id;
}

export async function updateOrgModel(
  orgId: string,
  modelDbId: string,
  data: {
    label?: string;
    api?: string;
    baseUrl?: string;
    modelId?: string;
    apiKey?: string;
    enabled?: boolean;
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
  },
): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot modify built-in model");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.label !== undefined) updates.label = data.label;
  if (data.api !== undefined) updates.api = data.api;
  if (data.baseUrl !== undefined) updates.baseUrl = data.baseUrl;
  if (data.modelId !== undefined) updates.modelId = data.modelId;
  if (data.apiKey !== undefined) updates.apiKeyEncrypted = encrypt(data.apiKey);
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.input !== undefined) updates.input = data.input;
  if (data.contextWindow !== undefined) updates.contextWindow = data.contextWindow;
  if (data.maxTokens !== undefined) updates.maxTokens = data.maxTokens;
  if (data.reasoning !== undefined) updates.reasoning = data.reasoning;

  await db
    .update(orgModels)
    .set(updates)
    .where(and(eq(orgModels.id, modelDbId), eq(orgModels.orgId, orgId)));
}

export async function deleteOrgModel(orgId: string, modelDbId: string): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot delete built-in model");
  }
  await db.delete(orgModels).where(and(eq(orgModels.id, modelDbId), eq(orgModels.orgId, orgId)));
}

export async function setDefaultModel(orgId: string, modelDbId: string | null): Promise<void> {
  // Reset all defaults for this org
  await db
    .update(orgModels)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(orgModels.orgId, orgId));

  if (modelDbId === null) return;

  // Only DB models can be flagged — system defaults are handled by the resolution cascade
  if (!isSystemModel(modelDbId)) {
    await db
      .update(orgModels)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(orgModels.id, modelDbId), eq(orgModels.orgId, orgId)));
  }
}

// --- Resolution ---

interface ResolvedModel {
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  label: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
}

function systemDefToResolved(def: ModelDefinition): ResolvedModel {
  return {
    api: def.api,
    baseUrl: def.baseUrl,
    modelId: def.modelId,
    apiKey: def.apiKey,
    label: def.label,
    input: def.input ?? null,
    contextWindow: def.contextWindow ?? null,
    maxTokens: def.maxTokens ?? null,
    reasoning: def.reasoning ?? null,
  };
}

export async function resolveModel(
  orgId: string,
  packageId: string,
  config?: Record<string, unknown>,
): Promise<ResolvedModel | null> {
  // 1. Check flow config for __modelId
  const resolved = config ?? (await getPackageConfig(orgId, packageId));
  const configModelId = resolved.__modelId as string | undefined | null;

  if (configModelId) {
    // Load specific model
    const result = await loadModel(orgId, configModelId);
    if (result) return result;
    logger.warn("Flow model override not found, falling through to org default", {
      packageId,
      modelId: configModelId,
    });
  }

  // 2. Find org default — check DB first
  const [dbDefault] = await db
    .select()
    .from(orgModels)
    .where(
      and(eq(orgModels.orgId, orgId), eq(orgModels.isDefault, true), eq(orgModels.enabled, true)),
    )
    .limit(1);

  if (dbDefault) {
    try {
      return {
        api: dbDefault.api,
        baseUrl: dbDefault.baseUrl,
        modelId: dbDefault.modelId,
        apiKey: decrypt(dbDefault.apiKeyEncrypted),
        label: dbDefault.label,
        input: dbDefault.input as string[] | null,
        contextWindow: dbDefault.contextWindow,
        maxTokens: dbDefault.maxTokens,
        reasoning: dbDefault.reasoning,
      };
    } catch {
      logger.warn("Failed to decrypt default model API key", { modelId: dbDefault.id });
    }
  }

  // 3. Check system models for a default
  const system = getSystemModels();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return systemDefToResolved(def);
    }
  }

  // 4. No fallback — model is required
  return null;
}

async function loadModel(orgId: string, modelDbId: string): Promise<ResolvedModel | null> {
  // Check system models first
  const system = getSystemModels();
  const systemDef = system.get(modelDbId);
  if (systemDef) {
    return systemDefToResolved(systemDef);
  }

  // Check DB
  const [row] = await db
    .select({
      api: orgModels.api,
      baseUrl: orgModels.baseUrl,
      modelId: orgModels.modelId,
      apiKeyEncrypted: orgModels.apiKeyEncrypted,
      enabled: orgModels.enabled,
      label: orgModels.label,
      input: orgModels.input,
      contextWindow: orgModels.contextWindow,
      maxTokens: orgModels.maxTokens,
      reasoning: orgModels.reasoning,
    })
    .from(orgModels)
    .where(and(eq(orgModels.id, modelDbId), eq(orgModels.orgId, orgId)))
    .limit(1);

  if (!row || !row.enabled) return null;

  try {
    return {
      api: row.api,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      apiKey: decrypt(row.apiKeyEncrypted),
      label: row.label,
      input: row.input as string[] | null,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
    };
  } catch {
    logger.warn("Failed to decrypt model API key", { modelId: modelDbId });
    return null;
  }
}
