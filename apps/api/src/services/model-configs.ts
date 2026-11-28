// SPDX-License-Identifier: Apache-2.0

/**
 * Model configurations (`model_configs`): one per catalog family of the organization, or
 * per endpoint of a gateway provider. A configuration owns its models (`org_models.config_id`)
 * and its connections (`model_provider_credentials.config_id`); which connection serves a model
 * is decided in `org-models.ts` from the configuration's connections.
 */

import { and, count, countDistinct, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  modelConfigs,
  modelProviderCredentials,
  organizations,
  orgModels,
} from "@appstrate/db/schema";
import type { ModelConfigInfo, ModelConfigOrgConnection } from "@appstrate/shared-types";
import { ApiError, conflict, invalidRequest, notFound } from "../lib/errors.ts";
import {
  inTransaction,
  isUniqueViolation,
  isUuid,
  scopedWhere,
  type DbOrTx,
} from "../lib/db-helpers.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import { EncryptionKeyUnavailableError } from "../lib/stored-credential.ts";
import { getModelProvider, listModelProviders } from "./model-providers/registry.ts";
import {
  configProviderOf,
  connectionFitsConfig,
  isGatewayProvider,
} from "./model-providers/credential-chain.ts";
import { loadInferenceCredentials } from "./model-providers/credentials.ts";
import { clearResolvedModelCache } from "./resolved-model-cache.ts";

export type ModelConfigRow = typeof modelConfigs.$inferSelect;

/** One configuration of the org; `null` for an unknown id, another org's, or a non-UUID. */
export async function loadModelConfig(
  orgId: string,
  id: string,
  executor: DbOrTx = db,
): Promise<ModelConfigRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await executor
    .select()
    .from(modelConfigs)
    .where(scopedWhere(modelConfigs, { orgId, extra: [eq(modelConfigs.id, id)] }))
    .limit(1);
  return row ?? null;
}

/** A configuration's label by default: the provider's name, prefixed by a gateway's host. */
function deriveConfigLabel(providerId: string, baseUrl: string | null): string {
  const name = getModelProvider(providerId)?.displayName ?? providerId;
  const host = baseUrl ? URL.parse(baseUrl)?.host : null;
  return host ? `${host} · ${name}` : name;
}

function modelConfigExists(existingId: string): ApiError {
  return conflict(
    "model_config_exists",
    "This organization already has a configuration for this provider (and endpoint).",
    { existing_config_id: existingId },
  );
}

async function findConfig(
  executor: DbOrTx,
  orgId: string,
  providerId: string,
  baseUrl: string | null,
): Promise<ModelConfigRow | null> {
  const [row] = await executor
    .select()
    .from(modelConfigs)
    .where(
      scopedWhere(modelConfigs, {
        orgId,
        extra: [
          eq(modelConfigs.providerId, providerId),
          baseUrl === null ? isNull(modelConfigs.baseUrl) : eq(modelConfigs.baseUrl, baseUrl),
        ],
      }),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The configuration of a non-gateway provider's family, created when missing (connection
 * creation without `config_id`, pairing redeem, onboarding). A gateway has no implicit one:
 * its endpoint must be chosen.
 */
async function ensureModelConfig(
  executor: DbOrTx,
  orgId: string,
  providerId: string,
  userId: string | null,
): Promise<ModelConfigRow> {
  const configProviderId = configProviderOf(providerId);
  if (isGatewayProvider(configProviderId)) {
    throw invalidRequest(
      `Provider ${providerId} takes its endpoint from a configuration: pass config_id`,
      "config_id",
    );
  }
  const existing = await findConfig(executor, orgId, configProviderId, null);
  if (existing) return existing;
  await executor
    .insert(modelConfigs)
    .values({
      orgId,
      providerId: configProviderId,
      label: deriveConfigLabel(configProviderId, null),
      createdBy: userId,
    })
    .onConflictDoNothing();
  // A concurrent insert won the unique index: read the row it wrote.
  const row = await findConfig(executor, orgId, configProviderId, null);
  if (!row) throw new Error("ensureModelConfig: configuration vanished after insert");
  return row;
}

/** The family configuration of a non-gateway provider, when the org has one (never created). */
export async function findFamilyConfig(
  orgId: string,
  providerId: string,
  executor: DbOrTx = db,
): Promise<ModelConfigRow | null> {
  return findConfig(executor, orgId, configProviderOf(providerId), null);
}

function connectionProviderMismatch(providerId: string, config: ModelConfigRow): ApiError {
  return new ApiError({
    status: 400,
    code: "connection_provider_mismatch",
    title: "Invalid Request",
    detail: `A ${providerId} connection does not fit the configuration '${config.label}' (${config.providerId})`,
    param: "config_id",
  });
}

/**
 * The configuration a new connection of `providerId` joins: the named one (it must be the
 * org's and fit the provider), else the provider's family configuration, found or created.
 */
export async function resolveConnectionConfig(
  executor: DbOrTx,
  orgId: string,
  providerId: string,
  configId: string | null | undefined,
  userId: string | null,
): Promise<ModelConfigRow> {
  if (configId == null) return ensureModelConfig(executor, orgId, providerId, userId);
  const config = await loadModelConfig(orgId, configId, executor);
  if (!config) throw notFound("Model configuration not found");
  if (!connectionFitsConfig(providerId, config.providerId)) {
    throw connectionProviderMismatch(providerId, config);
  }
  return config;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

interface CreateModelConfigInput {
  providerId: string;
  label?: string;
  baseUrl?: string;
  personalConnectionsAllowed?: boolean;
}

/** `base_url` belongs to a gateway configuration, and only to one. */
function checkBaseUrl(providerId: string, baseUrl: string | null | undefined): void {
  const gateway = isGatewayProvider(providerId);
  if (gateway && !baseUrl) {
    throw invalidRequest(`Provider ${providerId} needs a base_url`, "base_url");
  }
  if (!gateway && baseUrl != null) {
    throw invalidRequest(`Provider ${providerId} does not accept a base_url`, "base_url");
  }
}

export async function createModelConfig(
  orgId: string,
  userId: string | null,
  input: CreateModelConfigInput,
): Promise<string> {
  if (!getModelProvider(input.providerId)) {
    throw invalidRequest(`Unknown provider_id: ${input.providerId}`, "provider_id");
  }
  const providerId = configProviderOf(input.providerId);
  checkBaseUrl(providerId, input.baseUrl);
  const baseUrl = input.baseUrl ?? null;
  try {
    const [row] = await db
      .insert(modelConfigs)
      .values({
        orgId,
        providerId,
        label: input.label?.trim() || deriveConfigLabel(providerId, baseUrl),
        baseUrl,
        personalConnectionsAllowed: input.personalConnectionsAllowed ?? true,
        createdBy: userId,
      })
      .returning({ id: modelConfigs.id });
    return row!.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await findConfig(db, orgId, providerId, baseUrl);
    if (!existing) throw err;
    throw modelConfigExists(existing.id);
  }
}

interface UpdateModelConfigPatch {
  label?: string;
  baseUrl?: string;
  personalConnectionsAllowed?: boolean;
}

export async function updateModelConfig(
  orgId: string,
  id: string,
  patch: UpdateModelConfigPatch,
): Promise<void> {
  const config = await loadModelConfig(orgId, id);
  if (!config) throw notFound("Model configuration not found");
  if (patch.baseUrl !== undefined) checkBaseUrl(config.providerId, patch.baseUrl);
  const set: Partial<typeof modelConfigs.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.personalConnectionsAllowed !== undefined) {
    set.personalConnectionsAllowed = patch.personalConnectionsAllowed;
  }
  try {
    await db
      .update(modelConfigs)
      .set(set)
      .where(scopedWhere(modelConfigs, { orgId, extra: [eq(modelConfigs.id, id)] }));
  } catch (err) {
    if (!isUniqueViolation(err) || patch.baseUrl === undefined) throw err;
    const existing = await findConfig(db, orgId, config.providerId, patch.baseUrl);
    if (!existing) throw err;
    throw modelConfigExists(existing.id);
  }
  // The endpoint and the personal switch decide what serves a model.
  clearResolvedModelCache();
}

/**
 * Delete a configuration with its connections and models (FK cascade). The organization's
 * default pointer is cleared when it named one of those models.
 */
export async function deleteModelConfig(orgId: string, id: string): Promise<void> {
  const config = await loadModelConfig(orgId, id);
  if (!config) throw notFound("Model configuration not found");
  await inTransaction(db, async (tx) => {
    const models = tx
      .select({ id: sql`${orgModels.id}::text` })
      .from(orgModels)
      .where(and(eq(orgModels.orgId, orgId), eq(orgModels.configId, id)));
    await tx
      .update(organizations)
      .set({ defaultModelId: null })
      .where(and(eq(organizations.id, orgId), inArray(organizations.defaultModelId, models)));
    await tx
      .delete(modelConfigs)
      .where(scopedWhere(modelConfigs, { orgId, extra: [eq(modelConfigs.id, id)] }));
  });
  clearResolvedModelCache();
}

// ─── Listing ───────────────────────────────────────────────────────────────

/** The providers whose connections fit a configuration of `configProviderId`, API keys first. */
function acceptedProviders(configProviderId: string): ModelConfigInfo["accepts"] {
  return listModelProviders()
    .filter((def) => connectionFitsConfig(def.providerId, configProviderId))
    .sort((a, b) => Number(a.authMode === "oauth2") - Number(b.authMode === "oauth2"))
    .map((def) => ({
      provider_id: def.providerId,
      display_name: def.displayName,
      auth_mode: def.authMode,
    }));
}

/** A connection serves inference now; a key missing from the keyring reads as live (not the caller's to fix). */
async function connectionIsLive(orgId: string, id: string): Promise<boolean> {
  try {
    return (await loadInferenceCredentials(orgId, id)) !== null;
  } catch (err) {
    if (err instanceof EncryptionKeyUnavailableError) return true;
    throw err;
  }
}

/**
 * Every configuration of the org, sorted by label. `personal_connection_count` is given
 * only to a caller who may read the organization's credentials (`readsCredentials`).
 */
export async function listModelConfigs(
  orgId: string,
  options: { readsCredentials: boolean },
): Promise<ModelConfigInfo[]> {
  const configs = await db.select().from(modelConfigs).where(scopedWhere(modelConfigs, { orgId }));
  if (configs.length === 0) return [];
  const [orgConnections, personalCounts, modelCounts] = await Promise.all([
    db
      .select({ id: modelProviderCredentials.id, configId: modelProviderCredentials.configId })
      .from(modelProviderCredentials)
      .where(
        and(
          eq(modelProviderCredentials.orgId, orgId),
          isNull(modelProviderCredentials.ownerUserId),
        ),
      ),
    db
      .select({
        configId: modelProviderCredentials.configId,
        members: countDistinct(modelProviderCredentials.ownerUserId),
      })
      .from(modelProviderCredentials)
      .where(
        and(
          eq(modelProviderCredentials.orgId, orgId),
          isNotNull(modelProviderCredentials.ownerUserId),
        ),
      )
      .groupBy(modelProviderCredentials.configId),
    db
      .select({ configId: orgModels.configId, models: count(orgModels.id) })
      .from(orgModels)
      .where(eq(orgModels.orgId, orgId))
      .groupBy(orgModels.configId),
  ]);
  const live = new Map(
    await Promise.all(
      orgConnections.map(async (c) => [c.id, await connectionIsLive(orgId, c.id)] as const),
    ),
  );
  const orgConnectionOf = (configId: string): ModelConfigOrgConnection => {
    const mine = orgConnections.filter((c) => c.configId === configId);
    if (mine.some((c) => live.get(c.id))) return "active";
    return mine.length > 0 ? "needs_reconnection" : "none";
  };
  const personalOf = new Map(personalCounts.map((r) => [r.configId, r.members]));
  const modelsOf = new Map(modelCounts.map((r) => [r.configId, r.models]));
  return configs
    .map((config): ModelConfigInfo => ({
      id: config.id,
      provider_id: config.providerId,
      provider_name: getModelProvider(config.providerId)?.displayName ?? null,
      label: config.label,
      base_url: config.baseUrl,
      personal_connections_allowed: config.personalConnectionsAllowed,
      accepts: acceptedProviders(config.providerId),
      org_connection: orgConnectionOf(config.id),
      personal_connection_count: options.readsCredentials ? (personalOf.get(config.id) ?? 0) : null,
      model_count: modelsOf.get(config.id) ?? 0,
      createdAt: toISORequired(config.createdAt),
      updatedAt: toISORequired(config.updatedAt),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getModelConfigInfo(
  orgId: string,
  id: string,
  options: { readsCredentials: boolean },
): Promise<ModelConfigInfo | undefined> {
  return (await listModelConfigs(orgId, options)).find((config) => config.id === id);
}
