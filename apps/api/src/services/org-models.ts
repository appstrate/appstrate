// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelConfigs, modelProviderCredentials, orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import {
  type CatalogScope,
  listCatalogModels,
  lookupCatalogDialect,
  lookupCatalogModel,
  piProviderOf,
} from "./model-catalog.ts";
import {
  buildPiModel,
  clampPiReasoningLevel,
  piReasoningLevels,
} from "@appstrate/runner-pi/pi-model";
import { piReasoningOff } from "@appstrate/runner-pi/pi-reasoning-off";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import {
  MODEL_INPUT_MODALITIES,
  type ModelCost,
  type ModelInputModality,
  type ModelProviderDefinition,
} from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { checkEgressUrl, egressGuardedFetch } from "../lib/egress-host-guard.ts";
import { SsrfBlockedError } from "@appstrate/core/ssrf";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import type { ModelMetadata, OrgModelInfo, TestResult } from "@appstrate/shared-types";
import {
  effectiveBaseUrl,
  loadCredentialBinding,
  loadCredentialMetadata,
  loadInferenceCredentials,
} from "./model-providers/credentials.ts";
import {
  rankCandidates,
  servesModel,
  type ConnectionCandidate,
} from "./model-providers/credential-chain.ts";
import { loadModelConfig } from "./model-configs.ts";
import type { ModelPayer } from "@appstrate/core/model-payer";
import { EncryptionKeyUnavailableError } from "../lib/stored-credential.ts";
import type { ModelApiShape, PiModelDialect } from "@appstrate/core/sidecar-types";
import { clearResolvedModelCache, resolveModelCached } from "./resolved-model-cache.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  mergeSystemAndDb,
  buildUpdateSet,
  scopedWhere,
  createDefaultPointer,
  isInvalidTextRepresentation,
  isUniqueViolation,
  inTransaction,
  type DbOrTx,
  type Tx,
} from "../lib/db-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import { listedModelIds } from "./model-providers/model-listing.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";
import {
  MODEL_REASONING_LEVELS,
  ModelGenerationError,
  resolveModelGenerationSettings,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";

// --- Metadata projection ---

/**
 * Project the 6 metadata fields (label + 5 capability/cost fields) by
 * cascading source → catalog defaults → final fallback. This is the single
 * authoritative place where overrides beat the catalog — cost-shape
 * changes touch exactly one function.
 *
 * Used by every site that reads {@link ModelMetadata}: the wire-shape
 * projection (`listOrgModels` for both system and DB rows), and the resolved-
 * model builders for the run executor (`buildSystemResolvedModel`,
 * `buildResolvedModel`).
 */
export function resolveModelMetadata(
  src: ModelMetadata,
  modelId: string,
  defaults: CatalogDefaults,
): Required<Omit<ModelMetadata, "label">> & { label: string } {
  return {
    label: src.label ?? defaults.label ?? modelId,
    input: src.input ?? defaults.input ?? null,
    contextWindow: src.contextWindow ?? defaults.contextWindow ?? null,
    maxTokens: src.maxTokens ?? defaults.maxTokens ?? null,
    reasoning: src.reasoning ?? defaults.reasoning ?? null,
    cost: src.cost ?? defaults.cost ?? null,
  };
}

// --- Default pointer (org-level) ---

/**
 * The org's default model pointer — a flat id naming a system model or an
 * `org_models.id` (UUID), or `null` when no explicit default is set (the
 * resolver then falls to the system-flagged model). Single read path for the
 * pointer so list/resolve agree. The four pointer operations (read, first-row
 * promotion, set-default, dangling-clear) are the generic `createDefaultPointer`
 * helper — shared byte-for-byte with `org-proxies`.
 */
const defaultModel = createDefaultPointer({
  table: orgModels,
  pointerField: "defaultModelId",
  isSystem: isSystemModel,
  scopeWhere: (orgId, rowId) =>
    scopedWhere(orgModels, { orgId, extra: rowId !== undefined ? [eq(orgModels.id, rowId)] : [] }),
  entityName: "Model",
});

// --- Model-alias projection (Threat A: dashboard user) ---

/**
 * What an alias accepts, whatever its backing: a backing's own level set
 * fingerprints its family. Pi's default set — `xhigh`/`max` exist only where a
 * record maps them — and a run clamps the chosen level to the backing's
 * nearest (`clampToBackingLevel`).
 */
const ALIAS_REASONING_LEVELS: readonly ModelReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * An alias's public generation contract. Applied by {@link generationOf}, so
 * `listOrgModels` and `ResolvedModel` both carry it: settings are validated
 * against it, then {@link clampToBackingLevel} maps the level to the backing.
 */
function projectAliasedGenerationCapabilities(
  capabilities: ModelGenerationCapabilities | null,
): ModelGenerationCapabilities {
  const levels = Object.fromEntries(
    ALIAS_REASONING_LEVELS.map((level) => [level, "supported"]),
  ) as ModelGenerationCapabilities["reasoning"]["levels"];
  const temperatureSupported = capabilities?.temperature === "supported";
  const reasoningSupported = capabilities?.reasoning.supported === "supported";

  // Alias callers cannot inspect the backing model to compensate for an
  // unknown capability: expose only catalog-confirmed support, fail closed on
  // unknowns.
  return {
    temperature: temperatureSupported ? "supported" : "unsupported",
    reasoning: {
      supported: reasoningSupported ? "supported" : "unsupported",
      ...(temperatureSupported && reasoningSupported
        ? {
            temperature_compatible:
              capabilities?.reasoning.temperature_compatible === "supported"
                ? "supported"
                : "unsupported",
          }
        : {}),
      adaptive: null,
      // No `off`: what it sends would identify the backing, as its levels would.
      levels: reasoningSupported ? { ...levels } : {},
    },
  };
}

/**
 * Strip the real binding from a model alias before it reaches a user-facing
 * surface. For `aliased` entries the public `id`/`label` survive (the user
 * selected the alias) but the backing — provider/protocol (`apiShape`),
 * endpoint (`baseUrl`), upstream id (`modelId`), credential, and every
 * capability/cost field — is nulled: a distinctive context window or price
 * could identify the real model. `generation` is already the alias's public
 * contract (re-projecting it is idempotent). Non-aliased models pass through.
 *
 * Applied at the user-facing read boundary (`GET /api/models`, the effective-
 * default response), not inside {@link listOrgModels}, so the operator
 * create/update handlers still see the binding they configured. Resolution
 * (`resolveModel` / `loadModel`) keeps the real binding.
 */
export function projectAliasedModel(model: OrgModelInfo): OrgModelInfo {
  if (!model.aliased) return model;
  // Allowlist, NOT a denylist (`{ ...model, field: null }`): build the public
  // view from only the fields known safe to expose. A field added to
  // OrgModelInfo later then fails to compile here (required) or is simply
  // absent (optional) rather than silently riding along and leaking the
  // backing. Binding ids + every catalog-derived capability/cost field (which
  // would fingerprint the real model) are nulled.
  return {
    // Public — the user chose the alias by id/label.
    id: model.id,
    label: model.label,
    enabled: model.enabled,
    is_default: model.is_default,
    // Availability signal, NOT part of the backing — it names no provider,
    // endpoint or upstream id, so it fingerprints nothing (unlike the
    // capability/cost fields nulled below). Kept public because an alias can
    // itself go dead: a DB row may be `aliased` while pointing at a real stored
    // credential, and hiding the flag would put that alias right back in the
    // state this projection's caller must be able to act on — listed, unusable,
    // unexplained. (System/env aliases resolve from `SYSTEM_PROVIDER_KEYS`, a
    // static key that never goes stale, so for them it is always false.)
    needs_reconnection: model.needs_reconnection,
    aliased: model.aliased,
    // Deliberate public display icon — chosen on the alias, decoupled from the
    // backing provider, so it carries no fingerprint. Safe to surface.
    iconUrl: model.iconUrl,
    source: model.source,
    created_by: model.created_by,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    // Backing — always null for an alias.
    apiShape: null,
    providerId: null,
    provider_name: null,
    pi_provider: null,
    pi_dialect: null,
    base_url: null,
    modelId: null,
    // The configuration names the provider, so it stays private too; `billed_to`
    // names only the payer side.
    config_id: null,
    billed_to: model.billed_to,
    // Capability/cost — identifying catalog metadata stays private. Generation
    // exposes only the portable support vector needed by the controls; adaptive
    // transport semantics stay on the resolved model.
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    cost: null,
    generation: projectAliasedGenerationCapabilities(model.generation),
  };
}

// --- Serving (system + DB) ---

/** A connection of a configuration, as the serving order reads it. */
interface ConfigConnection extends ConnectionCandidate {
  configId: string;
}

type InferenceCredentials = NonNullable<Awaited<ReturnType<typeof loadInferenceCredentials>>>;

/**
 * What a connection can do for inference now: serve (`creds`), nothing because it is dead
 * but still listed (`dead`: revoked grant, blob that no longer decrypts), or nothing for a
 * reason a reconnect does not fix (`unavailable`: its row or provider is gone, or a key
 * this process lacks). `strict` turns a missing key on an ORGANIZATION connection into the
 * 503 it is; on a personal one it is skipped and logged, the payer's next one serving.
 */
type ConnectionState = { creds: InferenceCredentials } | "dead" | "unavailable";

async function connectionState(
  orgId: string,
  connection: ConnectionCandidate,
  strict: boolean,
): Promise<ConnectionState> {
  try {
    const creds = await loadInferenceCredentials(orgId, connection.id);
    if (creds) return { creds };
  } catch (err) {
    if (!(err instanceof EncryptionKeyUnavailableError)) throw err;
    if (strict && connection.ownerUserId === null) throw err;
    logger.warn("Model connection skipped: its encryption key is not in the keyring", {
      credentialId: connection.id,
    });
    return "unavailable";
  }
  return (await loadCredentialMetadata(connection.id, orgId)) ? "dead" : "unavailable";
}

interface ServingOutcome<T extends ConnectionCandidate> {
  served: { connection: T; creds: InferenceCredentials } | null;
  /** Some candidate is dead but listed: a reconnect would serve. */
  dead: boolean;
  /** Some ORGANIZATION candidate is dead but listed. */
  deadOrg: boolean;
}

/** The first ranked candidate that serves, and what the others say when none does. */
async function pickServing<T extends ConnectionCandidate>(
  ranked: readonly T[],
  state: (connection: T) => Promise<ConnectionState>,
): Promise<ServingOutcome<T>> {
  let dead = false;
  let deadOrg = false;
  for (const connection of ranked) {
    const s = await state(connection);
    if (typeof s === "object") return { served: { connection, creds: s.creds }, dead, deadOrg };
    if (s === "dead") {
      dead = true;
      if (connection.ownerUserId === null) deadOrg = true;
    }
  }
  return { served: null, dead, deadOrg };
}

/** The connections of these configurations of the org. */
async function listConfigConnections(
  orgId: string,
  configIds: readonly string[],
): Promise<ConfigConnection[]> {
  if (configIds.length === 0) return [];
  const rows = await db
    .select({
      id: modelProviderCredentials.id,
      providerId: modelProviderCredentials.providerId,
      ownerUserId: modelProviderCredentials.ownerUserId,
      createdAt: modelProviderCredentials.createdAt,
      configId: modelProviderCredentials.configId,
    })
    .from(modelProviderCredentials)
    .where(
      and(
        eq(modelProviderCredentials.orgId, orgId),
        inArray(modelProviderCredentials.configId, [...configIds]),
      ),
    );
  return rows.map((r) => ({ ...r, configId: r.configId! }));
}

/** A model row with its configuration, as serving reads it. */
interface ConfiguredModel {
  modelId: string;
  aliased?: boolean;
  configId: string;
  configProviderId: string;
  personalConnectionsAllowed: boolean;
}

/** The candidates that may serve `row` for `payerUserId`, best first. */
function candidatesFor<T extends ConfigConnection>(
  connections: readonly T[],
  row: ConfiguredModel,
  payerUserId: string | null,
  viaProxy = false,
): T[] {
  return rankCandidates(
    connections.filter((c) => c.configId === row.configId),
    {
      configProviderId: row.configProviderId,
      personalConnectionsAllowed: row.personalConnectionsAllowed,
      modelId: row.modelId,
      aliased: row.aliased === true,
      payerUserId,
      viaProxy,
    },
  );
}

export async function listOrgModels(
  orgId: string,
  payerUserId: string | null,
): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const joined = await db
    .select({
      row: orgModels,
      configProviderId: modelConfigs.providerId,
      configBaseUrl: modelConfigs.baseUrl,
      personalConnectionsAllowed: modelConfigs.personalConnectionsAllowed,
    })
    .from(orgModels)
    .innerJoin(modelConfigs, eq(modelConfigs.id, orgModels.configId))
    .where(scopedWhere(orgModels, { orgId }));
  // The default is an org-level pointer: when set, exactly that id is the
  // default (system or custom); when null, the system-flagged model wins.
  const pointer = await defaultModel.getDefaultId(orgId);
  const now = toISORequired(new Date());

  // "renderable", not "reachable": a row nothing serves is kept (flagged or unbilled) —
  // only a row whose configuration's provider is not registered is dropped.
  const rows = joined
    .filter((j) => getModelProvider(j.configProviderId))
    .map((j) => ({ ...j.row, ...j, configId: j.row.configId! }));

  const connections = await listConfigConnections(orgId, [...new Set(rows.map((r) => r.configId))]);
  // A connection is read once per call, however many models it serves.
  const states = new Map<string, Promise<ConnectionState>>();
  const stateOf = (c: ConnectionCandidate): Promise<ConnectionState> => {
    let state = states.get(c.id);
    if (!state) {
      state = connectionState(orgId, c, false);
      states.set(c.id, state);
    }
    return state;
  };
  // Who pays, for the caller: the platform for a built-in model, else the connection
  // that would serve the caller now (theirs or the organization's), or nobody.
  const outcomes = new Map<string, ServingOutcome<ConfigConnection>>();
  await Promise.all(
    rows.map(async (r) => {
      outcomes.set(r.id, await pickServing(candidatesFor(connections, r, payerUserId), stateOf));
    }),
  );
  const billedTo = (id: string): ModelPayer | null => {
    const served = outcomes.get(id)?.served;
    if (!served) return null;
    return served.connection.ownerUserId === null ? "org" : "user";
  };

  return mergeSystemAndDb<ModelDefinition, (typeof rows)[number], OrgModelInfo>({
    system,
    rows,
    mapSystem: (id, def): OrgModelInfo => {
      const defaults = resolveCatalogDefaults(def.providerId, def.modelId, "bundled");
      const metadata = resolveModelMetadata(def, def.modelId, defaults);
      return {
        id,
        ...metadata,
        generation: generationOf(defaults, {
          providerId: def.providerId,
          apiShape: def.apiShape,
          reasoning: metadata.reasoning,
          aliased: def.aliased === true,
        }),
        apiShape: def.apiShape,
        providerId: def.providerId,
        provider_name: getModelProvider(def.providerId)?.displayName ?? null,
        pi_provider: resolvePiProvider(def.providerId),
        pi_dialect: resolvePiDialect(def.providerId, def.modelId, "bundled"),
        base_url: def.baseUrl,
        modelId: def.modelId,
        enabled: def.enabled !== false,
        is_default: pointer !== null ? id === pointer : def.isDefault === true,
        // System (env) models read their key from `SYSTEM_PROVIDER_KEYS` — no
        // stored blob to be revoked or to stop decrypting, so never "dead".
        needs_reconnection: false,
        aliased: def.aliased === true,
        iconUrl: def.iconUrl ?? null,
        source: "built-in",
        config_id: null,
        billed_to: "system",
        created_by: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    mapRow: (row): OrgModelInfo => {
      const def = getModelProvider(row.configProviderId)!;
      const providerId = row.configProviderId;
      const defaults = resolveCatalogDefaults(providerId, row.modelId);
      const metadata = resolveModelMetadata(row, row.modelId, defaults);
      const outcome = outcomes.get(row.id)!;
      return {
        id: row.id,
        ...metadata,
        generation: generationOf(defaults, {
          providerId,
          apiShape: def.apiShape,
          reasoning: metadata.reasoning,
          aliased: row.aliased,
        }),
        apiShape: def.apiShape,
        providerId,
        provider_name: def.displayName,
        pi_provider: resolvePiProvider(providerId),
        pi_dialect: resolvePiDialect(providerId, row.modelId),
        base_url: effectiveBaseUrl(def, row.configBaseUrl),
        modelId: row.modelId,
        enabled: row.enabled,
        is_default: pointer !== null && row.id === pointer,
        // Nothing serves the caller, and a reconnect would.
        needs_reconnection: outcome.served === null && outcome.dead,
        aliased: row.aliased,
        // DB custom models declare no icon — the client resolves it from the
        // (visible) apiShape/baseUrl. Aliases live in env, never this table.
        iconUrl: null,
        source: row.source as "custom" | "built-in",
        config_id: row.configId,
        billed_to: billedTo(row.id),
        created_by: row.createdBy,
        createdAt: toISORequired(row.createdAt),
        updatedAt: toISORequired(row.updatedAt),
      };
    },
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Fetch a single org model by id, projected through the exact same serializer
 * as {@link listOrgModels} (so a mutation's return shape matches `GET`/list
 * byte-for-byte). Returns `undefined` when the id is unknown or its credential
 * row/provider is gone (the row is then absent from the list too). A dead
 * credential is NOT such a case — it resolves, flagged `needs_reconnection`.
 *
 * Used by the create/update handlers to return the full resource instead of an
 * id-only stub. Deliberately re-runs `listOrgModels` rather than
 * duplicating the merge/credential-resolution logic — these lists are small
 * (per-org models) and correctness/parity beats shaving one credential lookup.
 */
export async function getOrgModel(
  orgId: string,
  id: string,
  payerUserId: string | null,
): Promise<OrgModelInfo | undefined> {
  const all = await listOrgModels(orgId, payerUserId);
  return all.find((m) => m.id === id);
}

/**
 * Raw custom-model row fetch — NO credential resolution, NO reachability
 * filtering. {@link getOrgModel} still drops rows whose credential row/provider
 * is gone, which makes it unusable as the *pre-state* read for update-time
 * invariant checks (a row must be inspectable whatever its credential's
 * state). Exposes exactly the fields the update-time invariants
 * need: alias fields, plus the stored modelId + token-budget overrides (the
 * effective-state `maxTokens < contextWindow` check). System (env) models are
 * not rows — callers gate on `isSystemModel` first.
 */
export async function getOrgModelRow(
  orgId: string,
  id: string,
  executor: DbOrTx = db,
): Promise<
  | {
      label: string;
      configId: string | null;
      aliased: boolean;
      modelId: string;
      contextWindow: number | null;
      maxTokens: number | null;
    }
  | undefined
> {
  const [row] = await executor
    .select({
      label: orgModels.label,
      configId: orgModels.configId,
      aliased: orgModels.aliased,
      modelId: orgModels.modelId,
      contextWindow: orgModels.contextWindow,
      maxTokens: orgModels.maxTokens,
    })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, id)] }))
    .limit(1);
  return row;
}

/**
 * Derive a model label when the caller doesn't supply one. Picks the catalog
 * label (`(catalogProviderId ?? providerId, modelId)`) and dedupes against
 * existing org rows by appending ` (2)`, ` (3)`, …  Unknown models fall back
 * to `modelId` so the column (`NOT NULL`) always gets a value.
 */
export async function deriveModelLabel(
  orgId: string,
  providerId: string,
  modelId: string,
  /** Labels a batch already picked, not yet written: deduped against like stored ones. */
  pending: readonly string[] = [],
): Promise<string> {
  const defaults = resolveCatalogDefaults(providerId, modelId);
  const base = defaults.label ?? modelId;
  const rows = await db
    .select({ label: orgModels.label })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId }));
  return dedupeLabel(base, [...rows.map((r) => r.label), ...pending]);
}

// --- CRUD (DB models only) ---

/**
 * The loser of a duplicate add — the caller re-sending the same body, or two
 * concurrent adds — gets a 409 naming the row that already holds the model, not a
 * 500 carrying an index name. The database is the only arbiter: a read-then-insert
 * check would reopen the window `uq_org_models_config_model` closes.
 */
async function asDuplicateModel(
  err: unknown,
  orgId: string,
  configId: string,
  modelId: string,
  executor: DbOrTx = db,
): Promise<never> {
  if (!isUniqueViolation(err)) throw err;
  const [existing] = await executor
    .select({ id: orgModels.id })
    .from(orgModels)
    .where(
      scopedWhere(orgModels, {
        orgId,
        extra: [
          eq(orgModels.configId, configId),
          eq(orgModels.modelId, modelId),
          // The index is partial on `aliased = false`: an alias is never the refuser.
          eq(orgModels.aliased, false),
        ],
      }),
    )
    .limit(1);
  throw conflict(
    "model_already_added",
    `Model '${modelId}' is already added to this configuration`,
    existing ? { existing_model_id: existing.id } : undefined,
  );
}

export async function createOrgModel(
  orgId: string,
  label: string,
  modelId: string,
  userId: string,
  configId: string,
  capabilities?: {
    input?: ModelInputModality[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    cost?: ModelCost;
    aliased?: boolean;
  },
  executor: DbOrTx = db,
): Promise<string> {
  if (!(await loadModelConfig(orgId, configId, executor))) {
    throw notFound("Model configuration not found");
  }
  // The catch sits OUTSIDE the transaction on purpose: a failed statement
  // aborts it, so `asDuplicateModel`'s lookup could not run inside.
  try {
    return await inTransaction(executor, async (tx) => {
      const [row] = await tx
        .insert(orgModels)
        .values({
          orgId,
          label,
          modelId,
          configId,
          input: capabilities?.input ?? null,
          contextWindow: capabilities?.contextWindow ?? null,
          maxTokens: capabilities?.maxTokens ?? null,
          reasoning: capabilities?.reasoning ?? null,
          cost: capabilities?.cost ?? null,
          aliased: capabilities?.aliased ?? false,
          source: "custom",
          createdBy: userId,
        })
        .returning({ id: orgModels.id });

      // If this is the first model for the org, point the org default at it.
      await defaultModel.promoteIfFirst(tx, orgId, row!.id);
      return row!.id;
    });
  } catch (err) {
    return await asDuplicateModel(err, orgId, configId, modelId, executor);
  }
}

export async function updateOrgModel(
  orgId: string,
  modelDbId: string,
  data: {
    label?: string;
    modelId?: string;
    enabled?: boolean;
    input?: ModelInputModality[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
    aliased?: boolean;
  },
  executor: DbOrTx = db,
): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot modify built-in model");
  }
  const current = await getOrgModelRow(orgId, modelDbId, executor);
  if (!current) throw notFound("Model not found");

  // Keys of `updateModelSchema` (routes/models.ts).
  const updates = buildUpdateSet(data, [
    "label",
    "modelId",
    "enabled",
    "input",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "cost",
    "aliased",
  ]);

  const rowWhere = scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] });
  try {
    await inTransaction(executor, async (tx) => {
      // The default check is made on the row as locked, the lock `setDefaultModel`
      // also takes before checking `enabled`, so the two refusals cannot both be skipped.
      const [locked] = await tx
        .select({ id: orgModels.id })
        .from(orgModels)
        .where(rowWhere)
        .for("update");
      if (!locked) throw notFound("Model not found");
      if (data.enabled === false && (await defaultModel.getDefaultId(orgId, tx)) === modelDbId) {
        throw conflict(
          "model_disabled",
          "The default model cannot be disabled. Pick another default model first, or clear the default (PUT /api/models/default with `modelId: null`).",
        );
      }
      await tx.update(orgModels).set(updates).where(rowWhere);
    });
  } catch (err) {
    // Repointing a row's model id can land on one its configuration already holds.
    if (current.configId === null) throw err;
    await asDuplicateModel(err, orgId, current.configId, data.modelId ?? current.modelId, executor);
  }
  clearResolvedModelCache();
}

export async function deleteOrgModel(orgId: string, modelDbId: string): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot delete built-in model");
  }
  await db
    .delete(orgModels)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
  clearResolvedModelCache();
  // If the deleted model was the org default, clear the now-dangling pointer so
  // the resolver falls cleanly to the system cascade (no stale-id badge).
  await defaultModel.clearDanglingPointer(orgId, modelDbId);
}

/**
 * Atomically seed catalog models into a configuration. Called by the onboarding
 * quick-connect flow right after a pairing succeeds — replaces N client-side
 * POST /models calls.
 *
 * Skips entirely when the configuration already has models (idempotent for
 * re-connect flows). Promotes the first newly-created row to default when the org
 * has no default yet.
 */
interface SeedModelsResult {
  created: number;
  ids: string[];
  promotedDefault: boolean;
}

interface SeedModelsInput {
  models: ReadonlyArray<CatalogModelEntry & { id: string }>;
}

export async function seedOrgModelsForConfig(
  orgId: string,
  userId: string,
  configId: string,
  input: SeedModelsInput,
): Promise<SeedModelsResult> {
  if (!(await loadModelConfig(orgId, configId))) throw notFound("Model configuration not found");
  if (input.models.length === 0) return { created: 0, ids: [], promotedDefault: false };

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: orgModels.id })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.configId, configId)] }))
      .limit(1);
    if (existing.length > 0) {
      return { created: 0, ids: [], promotedDefault: false };
    }

    // Store catalog-derivable columns as null — read path falls back to
    // the catalog via `resolveCatalogDefaults`, so a Pi registry bump
    // propagates to these rows without a backfill migration.
    // Only `label` is materialised (DB column is NOT NULL); explicit
    // user-side renames remain stable across catalog bumps.
    const inserted = await tx
      .insert(orgModels)
      .values(
        input.models.map((m) => ({
          orgId,
          label: m.label,
          modelId: m.id,
          configId,
          input: null,
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          cost: null,
          source: "custom",
          createdBy: userId,
        })),
      )
      .returning({ id: orgModels.id });

    const promotedDefault =
      inserted.length > 0
        ? await defaultModel.setDefaultIfUnset(tx, orgId, inserted[0]!.id)
        : false;

    return {
      created: inserted.length,
      ids: inserted.map((r) => r.id),
      promotedDefault,
    };
  });
}

/**
 * Set (or clear, with `null`) the org's default model. The id may name a system
 * model OR one of the org's own rows — picking any row makes exactly that row
 * the default (the integration `setDefaultIntegrationClient` analogue). An
 * unknown custom id is rejected, never stored. A single pointer write — no
 * per-row flag flip — made under the target row's lock, the one
 * {@link updateOrgModel} takes to refuse disabling the default.
 */
export async function setDefaultModel(orgId: string, modelDbId: string | null): Promise<void> {
  // The pointer feeds every run, chat and schedule, including the calls no member
  // pays for: an enabled custom model must be served by a live ORGANIZATION
  // connection. The check lives in this service — NOT in `createDefaultPointer`,
  // which is shared byte-for-byte with `org-proxies` and must stay generic. System
  // ids, unknown rows and non-UUIDs carry no configuration, so the pointer helper
  // below still owns the 404.
  const row =
    modelDbId === null || isSystemModel(modelDbId)
      ? null
      : await loadOrgModelHead(orgId, modelDbId);
  if (row?.enabled) await assertOrgServesDefault(orgId, row);
  await db.transaction((tx) => writeDefaultModel(tx, orgId, modelDbId, !!row));
}

/**
 * Refuse a model as the default unless a live ORGANIZATION connection of its
 * configuration serves it (409 `model_needs_reconnection` when one would after a
 * reconnect, else 409 `model_org_connection_required`). Decrypts: call it before
 * any transaction. Shared by {@link setDefaultModel} and `POST /api/models/apply`,
 * which may name a model it creates in the same write.
 */
export async function assertOrgServesDefault(orgId: string, model: ConfiguredModel): Promise<void> {
  const connections = await listConfigConnections(orgId, [model.configId]);
  const outcome = await pickServing(candidatesFor(connections, model, null), (c) =>
    connectionState(orgId, c, true),
  );
  if (!outcome.served && outcome.deadOrg) {
    throw conflict(
      "model_needs_reconnection",
      "This model's organization connection must be reconnected before it can be the default model. Reconnect it, or pick another model.",
    );
  }
  if (!outcome.served) {
    throw conflict(
      "model_org_connection_required",
      "The default model serves schedules, API keys and end users, which only an organization connection can pay for. Connect the organization to this model's configuration, or pick another model.",
    );
  }
}

/**
 * The write half of {@link setDefaultModel}, inside the caller's transaction: refuses a disabled
 * row (read under its lock), then stores the pointer. `custom` says the id is one of the org's
 * rows (a system id is trusted via the registry). The dead-credential check is the caller's,
 * made before the transaction — it decrypts, which no transaction should wait on.
 */
export async function writeDefaultModel(
  tx: Tx,
  orgId: string,
  modelDbId: string | null,
  custom: boolean,
): Promise<void> {
  // `resolveModel` skips a switched-off row. `enabled` is read under the row
  // lock `updateOrgModel` takes before checking the pointer, so a concurrent
  // disable is either seen here or sees this pointer.
  if (custom && modelDbId !== null) {
    const [locked] = await tx
      .select({ enabled: orgModels.enabled })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
      .for("update");
    if (locked && !locked.enabled) {
      throw conflict(
        "model_disabled",
        "A disabled model cannot be the default model. Enable it, or pick another model.",
      );
    }
  }
  // Validate the target before storing it (mirrors the integration set-default
  // guard). A system id is trusted via the registry; a custom id must be a row
  // the org owns.
  await defaultModel.setDefault(orgId, modelDbId, tx);
}

// --- Resolution ---

/**
 * Canonical resolved-model shape — produced by {@link resolveModel} /
 * {@link loadModel}, consumed by the run-context-builder. Passed through to the
 * run executor verbatim as `AppstrateRunPlan.llmConfig`; the executor
 * only reads inference fields. `accountId` is set for OAuth credentials
 * whose provider hook surfaced an identity claim — the sidecar re-reads
 * it from the credential row on each request, so the executor ignores it.
 *
 * Inference fields (providerId, apiShape, …, cost) mirror
 * {@link ModelDefinition} so the env-driven and DB-driven paths feed the
 * run executor the same shape.
 */
export interface ResolvedModel extends Pick<
  ModelDefinition,
  | "providerId"
  | "apiShape"
  | "baseUrl"
  | "modelId"
  | "apiKey"
  | "input"
  | "contextWindow"
  | "maxTokens"
  | "reasoning"
  | "cost"
> {
  /**
   * Pi builtin provider key of {@link providerId} (`piProviderOf`), `null` for
   * a gateway. The key every runtime channel carries — never the Appstrate id.
   */
  piProvider: string | null;
  /** The Pi dialect of the catalog's record; `null` for a model it does not record. */
  dialect: PiModelDialect | null;
  /** Request controls supported by the backing model in the catalog. */
  generation?: ModelGenerationCapabilities;
  /**
   * Always set — the builders fall back to the catalog and finally `modelId`
   * so callers can read it as a plain string even when the env entry or DB
   * row omitted it. `ModelDefinition.label` stays optional on purpose
   * (storage-side) — `ResolvedModel.label` is its post-resolution view.
   */
  label: string;
  /**
   * Whose credential serves inference: the platform's (`system`, SYSTEM_PROVIDER_KEYS),
   * an organization's (`org`), a member's own (`user`), or `null` for an unbound
   * model that no credential serves for this caller.
   */
  credentialSource: ModelPayer | null;
  /** The member whose own credential serves the call — set iff credentialSource === "user". */
  payerUserId?: string;
  /**
   * Model-alias flag (LLM-gateway alias pattern). When true the run executor
   * hands the sidecar the {@link aliasId} as the container's `MODEL_ID` and the
   * sidecar swaps it for the real {@link modelId} on every inference call (and
   * back on the response). The agent never sees the real backing model.
   */
  aliased: boolean;
  /**
   * Public alias id the user selected — `ModelDefinition.id` for system models,
   * the `org_models.id` (UUID) for DB rows. Distinct from {@link modelId} (the
   * real upstream id) only when {@link aliased} is true; otherwise equal in
   * effect. Carried so the sidecar can rewrite real→alias in responses.
   */
  aliasId: string;
  /**
   * Abstract account/tenant identifier surfaced by the credential's
   * `extractTokenIdentity` hook. Consumed by the offline credential check
   * (`validateCredential` in testModelConfig); it is NOT injected as a
   * request header — any routing header (e.g. codex `chatgpt-account-id`)
   * is emitted by pi-ai inside the container from the token/placeholder,
   * and the sidecar only swaps the bearer.
   */
  accountId?: string;
  /** `model_provider_credentials` row id — passed to the sidecar so it can pull fresh OAuth tokens at request time. Unset for system (env-driven) keys and unbound models. */
  credentialId?: string;
}

/** A resolved model with a credential to spend: what every spend site runs on. */
export type BoundModel = ResolvedModel & { credentialSource: ModelPayer };

/** What a resolved model is built from: an org row or a system definition. */
interface ModelHead extends ModelMetadata {
  id: string;
  modelId: string;
  aliased?: boolean;
}

/** An org row as the resolver reads it, with its configuration. */
interface DbOrgModelHead extends ModelHead, ConfiguredModel {
  enabled: boolean;
  configBaseUrl: string | null;
}

interface DbModelCredentials {
  apiKey: string;
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  accountId?: string;
}

/**
 * The credential a resolved model is served with; no `credentialId` for an unbound
 * model, an `ownerUserId` for a member's own credential.
 */
interface ServingCredentials extends DbModelCredentials {
  credentialId?: string;
  ownerUserId?: string | null;
}

/**
 * Catalog-derived defaults for `(providerId, modelId)`. Each `org_models`
 * column is an *optional override* — when the row stores null, the catalog
 * value flows through here. Storing nulls instead of frozen catalog values
 * lets a Pi registry bump propagate to existing rows. Reads the provider's
 * offer (`catalogProviderId ?? providerId` on its `apiShape`).
 *
 * Returns `{}` on any miss (unknown provider, id outside the offer) and no
 * `cost` for a model the catalog leaves unpriced. Callers fall through to
 * row values or final defaults.
 */
export interface CatalogDefaults {
  label?: string;
  input?: ModelInputModality[];
  contextWindow?: number;
  maxTokens?: number | null;
  reasoning?: boolean;
  cost?: ModelCost;
  generation?: ModelGenerationCapabilities;
}

export function resolveCatalogDefaults(
  providerId: string,
  modelId: string,
  scope: CatalogScope = "all",
): CatalogDefaults {
  const provider = getModelProvider(providerId);
  const entry = provider ? lookupCatalogModel(provider, modelId, scope) : null;
  if (!entry) return {};
  return {
    label: entry.label,
    input: MODEL_INPUT_MODALITIES.filter((m) => entry.capabilities.includes(m)),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.capabilities.includes("reasoning"),
    ...(entry.cost ? { cost: entry.cost } : {}),
    generation: entry.generation,
  };
}

/**
 * What decides the controls of a model: its provider and API, its declared
 * reasoning, and whether it is an alias.
 */
interface GenerationSubject {
  providerId: string;
  apiShape: string;
  reasoning: boolean | null;
  aliased: boolean;
}

/**
 * The controls of a model the catalog has no record of: the reasoning levels Pi
 * takes, and what its `off` sends, for the model a run builds for it
 * ({@link buildPiModel}). Its temperature support stays unknown.
 */
function unrecordedGeneration({
  providerId,
  apiShape,
  reasoning,
}: GenerationSubject): ModelGenerationCapabilities {
  const model = buildPiModel({
    id: "",
    dialect: null,
    apiShape,
    piProvider: resolvePiProvider(providerId),
    // Required by the builder; nothing derived here reads it.
    baseUrl: "",
    reasoning,
  });
  const levels = new Set<string>(piReasoningLevels(model));
  const off = piReasoningOff(model);
  return {
    temperature: "unknown",
    reasoning: {
      supported: reasoning ? "supported" : "unsupported",
      adaptive: null,
      levels: Object.fromEntries(
        MODEL_REASONING_LEVELS.map((level) => [
          level,
          levels.has(level) ? "supported" : "unsupported",
        ]),
      ),
      ...(off ? { off } : {}),
    },
  };
}

/** The controls a caller may set: an alias's are its public contract, never its backing's. */
function generationOf(
  defaults: CatalogDefaults,
  subject: GenerationSubject,
): ModelGenerationCapabilities {
  const generation = defaults.generation ?? unrecordedGeneration(subject);
  return subject.aliased ? projectAliasedGenerationCapabilities(generation) : generation;
}

function resolvePiProvider(providerId: string): string | null {
  const def = getModelProvider(providerId);
  return def ? piProviderOf(def) : null;
}

/** The Pi dialect of the provider's record of `modelId` — what every model builder is handed. */
function resolvePiDialect(
  providerId: string,
  modelId: string,
  scope: CatalogScope = "all",
): PiModelDialect | null {
  const def = getModelProvider(providerId);
  return def ? lookupCatalogDialect(def, modelId, scope) : null;
}

/** Build a `ResolvedModel` from a system `ModelDefinition` (env-driven), served by the platform's key. */
function buildSystemResolvedModel(def: ModelDefinition): ResolvedModel {
  // The bundled registry alone: the platform pays for a system model.
  const defaults = resolveCatalogDefaults(def.providerId, def.modelId, "bundled");
  const metadata = resolveModelMetadata(def, def.modelId, defaults);
  return {
    providerId: def.providerId,
    piProvider: resolvePiProvider(def.providerId),
    dialect: resolvePiDialect(def.providerId, def.modelId, "bundled"),
    apiShape: def.apiShape,
    baseUrl: def.baseUrl,
    modelId: def.modelId,
    apiKey: def.apiKey,
    ...metadata,
    generation: generationOf(defaults, {
      providerId: def.providerId,
      apiShape: def.apiShape,
      reasoning: metadata.reasoning,
      aliased: def.aliased === true,
    }),
    credentialSource: "system",
    aliased: def.aliased === true,
    aliasId: def.id,
  };
}

/** Who pays a stored credential: its owner for a member's own, the organization otherwise. */
export function credentialPayer(ownerUserId: string | null | undefined): {
  credentialSource: ModelPayer;
  payerUserId?: string;
} {
  return ownerUserId
    ? { credentialSource: "user", payerUserId: ownerUserId }
    : { credentialSource: "org" };
}

/**
 * Build a `ResolvedModel` from its definition and the credential serving it.
 * `apiShape` and `baseUrl` come from that credential (the registry resolves them
 * by `providerId`). Every catalog-derivable column on `org_models` is an optional
 * override that defers to the catalog on null — so a Pi registry bump propagates.
 */
function buildResolvedModel(head: ModelHead, serving: ServingCredentials): ResolvedModel {
  const defaults = resolveCatalogDefaults(serving.providerId, head.modelId);
  const metadata = resolveModelMetadata(head, head.modelId, defaults);
  const aliased = head.aliased === true;
  return {
    providerId: serving.providerId,
    piProvider: resolvePiProvider(serving.providerId),
    dialect: resolvePiDialect(serving.providerId, head.modelId),
    apiShape: serving.apiShape,
    baseUrl: serving.baseUrl,
    modelId: head.modelId,
    apiKey: serving.apiKey,
    ...metadata,
    generation: generationOf(defaults, {
      providerId: serving.providerId,
      apiShape: serving.apiShape,
      reasoning: metadata.reasoning,
      aliased,
    }),
    ...(serving.credentialId === undefined
      ? { credentialSource: null }
      : credentialPayer(serving.ownerUserId)),
    aliased,
    aliasId: head.id,
    accountId: serving.accountId,
    credentialId: serving.credentialId,
  };
}

/** A resolved model and whether it is the one asked for (`fromExplicit`) or a cascade fallback. */
export type ModelCascade = { model: ResolvedModel; fromExplicit: boolean } | null;

export async function resolveModelCascade(
  orgId: string,
  packageId: string,
  modelId: string | null,
  payerUserId: string | null,
): Promise<ModelCascade> {
  // 1. Explicit override (agent column or per-run)
  if (modelId) {
    const result = await loadModel(orgId, modelId, payerUserId);
    if (result) return { model: result, fromExplicit: true };
    logger.warn("Agent model override not found, falling through to org default", {
      packageId,
      modelId,
    });
  }

  // 2. Org default — the pointer names a system model or a custom row; load it
  //    directly. A stale pointer (deleted/disabled row) resolves to null and
  //    falls through to the system cascade.
  const pointer = await defaultModel.getDefaultId(orgId);
  if (pointer) {
    const resolved = await loadModel(orgId, pointer, payerUserId);
    if (resolved) return { model: resolved, fromExplicit: false };
  }

  // 3. System default.
  for (const [id, def] of getSystemModels()) {
    if (def.isDefault && def.enabled !== false) {
      const model = await loadModel(orgId, id, null);
      if (model) return { model, fromExplicit: false };
    }
  }

  // 4. No model configured
  return null;
}

export async function resolveModel(
  orgId: string,
  packageId: string,
  modelId: string | null,
  payerUserId: string | null,
): Promise<ResolvedModel | null> {
  return (await resolveModelCascade(orgId, packageId, modelId, payerUserId))?.model ?? null;
}

/**
 * Refuse a model no connection serves for this call. `payerUserId` words the fix: a
 * payer adds their own connection; a call with none needs an organization connection.
 */
export function requireBoundModel(model: ResolvedModel, payerUserId: string | null): BoundModel {
  if (model.credentialSource === null) {
    throw conflict(
      "model_credential_required",
      payerUserId
        ? `No connection serves model '${model.label}' for you: add your own connection under Preferences → Models, or ask an administrator to connect the organization.`
        : `No organization connection serves model '${model.label}': schedules, API keys and end users can only use models an organization connection serves. Ask an administrator to connect the organization to this model's configuration.`,
    );
  }
  return { ...model, credentialSource: model.credentialSource };
}

/**
 * Resolve a model for `payerUserId`, whose personal connections of the model's
 * configuration may serve it (`null`: none may). A built-in model is the platform's
 * whoever calls. `viaProxy` leaves subscriptions out (the LLM proxy never serves one).
 * `null` when the model is missing or disabled, or when an organization connection
 * that would serve it is dead.
 */
export async function loadModel(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null,
  options?: { viaProxy?: boolean },
): Promise<ResolvedModel | null> {
  const systemDef = getSystemModels().get(modelDbId);
  if (systemDef) {
    // A built-in model is the platform's whoever calls, and already in memory.
    return buildSystemResolvedModel(systemDef);
  }
  const viaProxy = options?.viaProxy === true;
  return resolveModelCached(orgId, modelDbId, { kind: "payer", payerUserId, viaProxy }, () =>
    resolveDbModel(orgId, modelDbId, payerUserId, viaProxy),
  );
}

/**
 * The model a run's proxy calls are served: a personal connection the run launched
 * with keeps serving that run, and only for the payer the run recorded, while its
 * configuration still allows personal connections and it still serves the (enabled,
 * unaliased) model of the same configuration; anything else is served as the model
 * is now, by the organization or the platform. `run` is `runs.model_credential_id`
 * and `runs.payer_user_id`.
 */
export async function loadRunModel(
  orgId: string,
  modelDbId: string,
  run: { credentialId: string | null; payerUserId: string | null },
): Promise<ResolvedModel | null> {
  const { credentialId } = run;
  if (!credentialId) return loadModel(orgId, modelDbId, null, { viaProxy: true });
  const slot = { kind: "run", credentialId, payerUserId: run.payerUserId } as const;
  return resolveModelCached(orgId, modelDbId, slot, async () => {
    const binding = await loadCredentialBinding(orgId, credentialId);
    if (!binding?.ownerUserId) return loadModel(orgId, modelDbId, null, { viaProxy: true });
    if (binding.ownerUserId !== run.payerUserId) return null;
    const row = await loadOrgModelHead(orgId, modelDbId);
    if (
      !row ||
      !row.enabled ||
      row.aliased ||
      row.configId !== binding.configId ||
      !row.personalConnectionsAllowed ||
      !servesModel(binding.providerId, row.configProviderId, row.modelId)
    ) {
      return null;
    }
    const state = await connectionState(
      orgId,
      { ...binding, id: credentialId, createdAt: new Date() },
      false,
    );
    return typeof state === "object"
      ? buildResolvedModel(row, { ...state.creds, credentialId, ownerUserId: binding.ownerUserId })
      : null;
  });
}

/**
 * Read one org row by id with its configuration. A `modelDbId` that is not a valid
 * UUID (e.g. `gpt-5.5`) is "not found", not a 500.
 */
async function loadOrgModelHead(orgId: string, modelDbId: string): Promise<DbOrgModelHead | null> {
  // `22P02` = invalid_text_representation (the uuid cast failure), normalised below.
  try {
    const [row] = await db
      .select({
        id: orgModels.id,
        modelId: orgModels.modelId,
        enabled: orgModels.enabled,
        label: orgModels.label,
        input: orgModels.input,
        contextWindow: orgModels.contextWindow,
        maxTokens: orgModels.maxTokens,
        reasoning: orgModels.reasoning,
        cost: orgModels.cost,
        aliased: orgModels.aliased,
        configId: modelConfigs.id,
        configProviderId: modelConfigs.providerId,
        configBaseUrl: modelConfigs.baseUrl,
        personalConnectionsAllowed: modelConfigs.personalConnectionsAllowed,
      })
      .from(orgModels)
      .innerJoin(modelConfigs, eq(modelConfigs.id, orgModels.configId))
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
      .limit(1);
    return row ?? null;
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return null;
    throw err;
  }
}

/** One custom model, served by the first candidate connection of its configuration. */
async function resolveDbModel(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null,
  viaProxy: boolean,
): Promise<ResolvedModel | null> {
  const row = await loadOrgModelHead(orgId, modelDbId);
  if (!row || !row.enabled) return null;
  // A configuration naming a provider this instance does not register must
  // not resolve to null: every caller reads null as "fall through to the org or
  // system default", which would silently run on — and bill — another model.
  const def = getModelProvider(row.configProviderId);
  if (!def) {
    throw conflict(
      "model_provider_unregistered",
      `Model '${modelDbId}' belongs to a configuration of provider '${row.configProviderId}', which ` +
        `this instance does not register. Load that provider's module again (MODULES), or have an ` +
        `operator remove the configuration.`,
    );
  }
  const connections = await listConfigConnections(orgId, [row.configId]);
  const { served, deadOrg } = await pickServing(
    candidatesFor(connections, row, payerUserId, viaProxy),
    (c) => connectionState(orgId, c, true),
  );
  if (served) {
    return buildResolvedModel(row, {
      ...served.creds,
      credentialId: served.connection.id,
      ownerUserId: served.connection.ownerUserId,
    });
  }
  // A dead organization connection is the organization's to reconnect: the model is
  // unusable, as a dead bound credential always was.
  if (deadOrg) return null;
  return buildResolvedModel(row, {
    providerId: row.configProviderId,
    apiShape: def.apiShape,
    baseUrl: effectiveBaseUrl(def, row.configBaseUrl),
    apiKey: "",
  });
}

/**
 * Disambiguate the `loadModel(...) === null` result for an org (DB) model: is it
 * null because the model is missing/disabled, or because a connection that would
 * serve it can no longer serve inference (a revoked OAuth grant, a key rejected
 * upstream too often, a blob that no longer decrypts)? `true` iff the row exists,
 * is enabled, nothing serves it for `payerUserId`, and some candidate is dead but
 * still listed — so a caller can surface an actionable "reconnect" instead of a
 * misleading "not found / not enabled".
 */
export async function modelNeedsReconnection(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null = null,
): Promise<boolean> {
  if (isSystemModel(modelDbId)) return false;
  const row = await loadOrgModelHead(orgId, modelDbId);
  if (!row || !row.enabled) return false;
  const connections = await listConfigConnections(orgId, [row.configId]);
  const outcome = await pickServing(candidatesFor(connections, row, payerUserId), (c) =>
    connectionState(orgId, c, false),
  );
  return outcome.served === null && outcome.dead;
}

/**
 * Validate an explicit, caller-supplied `modelId` (run body / schedule row).
 *
 * `loadModel` resolves both system-model keys and org-model UUIDs, returning
 * null for anything else (including non-UUID strings, which it now swallows
 * rather than letting Postgres throw). A null here means the caller referenced
 * a model that doesn't exist — surface a deterministic 404 with a helpful
 * message instead of silently falling through to the org default (which is the
 * intended graceful behaviour only for persisted agent-column pins resolved via
 * {@link resolveModel}).
 *
 * No-op when `modelId` is null/undefined (no explicit override supplied).
 */
export async function assertExplicitModelExists(
  orgId: string,
  modelId: string | null | undefined,
): Promise<ResolvedModel | null> {
  if (!modelId) return null;
  // Whether a model exists does not depend on who pays for it.
  const model = await loadModel(orgId, modelId, null);
  if (!model) {
    throw notFound(`Model '${modelId}' not found — expected a model UUID or a system model key`);
  }
  return model;
}

/**
 * Validate a caller-supplied generation-settings override against the model it
 * will actually run on, and answer the two ways it can be refused.
 *
 * One implementation, three routes: `PATCH /agents/{scope}/{name}/model`,
 * `PATCH /spaces/{id}/packages/{scope}/{name}` and the two schedule
 * handlers each ran their own copy of this — same two refusals, same literal
 * message spelled out four times, and only the `param` legitimately differed
 * (it names the wire field the override arrived on, which is `generation`,
 * `generation_config` and `generation_config_override` respectively).
 *
 * `selectedModel` is the resolved model this layer will run on, or `null` when
 * NOTHING resolves — no override, no agent pin, no org default. Generation
 * settings are per-model request controls, so there is nothing to validate them
 * against and nothing to clamp them to; storing them would mean persisting a
 * value the next resolution could contradict.
 *
 * RESPONSE-SHAPE CHANGE, DELIBERATE. All four route-local copies threw the
 * `!selectedModel` refusal with NO `param` — only their `ModelGenerationError`
 * sibling carried one. Hoisting them here gives BOTH refusals the same `param`,
 * so the 400 on `PATCH /agents/{scope}/{name}/model`, `PATCH /spaces/{id}/
 * packages/{scope}/{name}` and both schedule surfaces now carries a `param` it
 * did not carry before. Kept rather than reverted: the two refusals come from
 * one body field and now describe it identically, `param` is optional in the
 * `ProblemDetail` schema (`openapi/schemas.ts`), and no consumer branches on
 * its ABSENCE — `apps/web` reads `param` only for the two `locked_*_field`
 * codes (`hooks/use-mutations.ts`), and `api/client.ts` passes it through
 * untouched. Each of the four surfaces pins its own `param` in the integration
 * tests, so a silent revert fails.
 */
export function validateGenerationOverride(
  override: ModelGenerationSettings,
  selectedModel: Pick<ResolvedModel, "generation"> | null,
  param: string,
): ModelGenerationSettings {
  if (!selectedModel) {
    throw invalidRequest(
      "A model must be configured before generation settings can be saved",
      param,
    );
  }
  try {
    return resolveModelGenerationSettings({
      capabilities: selectedModel.generation,
      override,
    });
  } catch (error) {
    if (error instanceof ModelGenerationError) {
      throw invalidRequest(error.message, param);
    }
    throw error;
  }
}

/**
 * The settings a run sends upstream: its reasoning level mapped to what the
 * model really takes (Pi's clamp). A no-op on a strictly validated model; an
 * alias's public level lands on its backing's nearest, since the container of
 * an aliased run never learns the backing.
 */
export function clampToBackingLevel(
  model: ResolvedModel,
  settings: ModelGenerationSettings,
): ModelGenerationSettings {
  const level = settings.reasoning_level;
  if (level == null) return settings;
  const piModel = buildPiModel({
    id: model.modelId,
    dialect: model.dialect,
    apiShape: model.apiShape,
    piProvider: model.piProvider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
  });
  return { ...settings, reasoning_level: clampPiReasoningLevel(piModel, level) };
}

// --- Connection test ---

/**
 * Build the URL + headers of a model provider's model listing. Pure for unit
 * testing. Takes no model id: a `GET <baseUrl>/models` identifies the
 * CREDENTIAL, never one model.
 */
export function buildModelTestRequest(config: {
  apiShape: string;
  baseUrl: string;
  apiKey: string;
  providerId?: string;
}): {
  url: string;
  headers: Record<string, string>;
} {
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  let url: string;

  switch (config.apiShape) {
    case "anthropic-messages":
      // API-key only — OAuth subscription tokens (`sk-ant-oat-*`) are
      // not used by any provider Appstrate ships out of the box.
      url = `${base}/v1/models`;
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "mistral-conversations":
      url = `${base}/v1/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
    default:
      url = `${base}/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
  }

  return { url, headers };
}

/** A delivered response, or the structured failure that stopped it from being one. */
type ProviderFetchResult =
  { ok: true; res: Response; latency: number } | (TestResult & { ok: false });

/**
 * The guarded `GET <baseUrl>/models` request, shared by {@link testModelConfig}
 * (reads the status) and `listServedModels` (parses the body): the SSRF
 * pre-flight, the pinned transport and the pre-response failure mapping exist once.
 *
 * `pageQuery` asks for a page other than the first, spending the cursor the
 * previous page published. It is appended to the URL the shape builds rather
 * than merged into it: the request is always derived from the base URL, so the
 * cursor cannot accumulate across pages and the first page stays byte-identical
 * to a request that carries none.
 */
export async function fetchModelListing(
  config: {
    apiShape: string;
    baseUrl: string;
    apiKey: string;
    providerId?: string;
  },
  pageQuery?: { name: string; value: string },
): Promise<ProviderFetchResult> {
  const { url: firstPageUrl, headers } = buildModelTestRequest(config);
  const url = pageQuery
    ? `${firstPageUrl}${firstPageUrl.includes("?") ? "&" : "?"}${pageQuery.name}=${encodeURIComponent(pageQuery.value)}`
    : firstPageUrl;
  return guardedProviderFetch(config.baseUrl, url, { headers });
}

/** Every provider request: {@link fetchModelListing}, {@link validateKeyByInference}. */
async function guardedProviderFetch(
  baseUrl: string,
  url: string,
  init: Omit<RequestInit, "signal">,
): Promise<ProviderFetchResult> {
  // Canonical egress guard (parse + scheme floor + allowlist-aware literal +
  // DNS-rebind host gate) before the fetch: a public hostname resolving to a
  // private/loopback/link-local address is refused, fail-closed, with the same
  // BLOCKED_URL result (the resolution reason is never surfaced).
  const egress = await checkEgressUrl(baseUrl);
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
    // SSRF-guarded transport (per-hop DNS + blocklist, connection pinned to
    // the validated address) — the pre-flight `checkEgressUrl` above cannot by
    // itself stop a DNS-rebind between check and connect, so the wire call
    // must own the pin. `maxRedirects: 0`: the request carries the provider
    // API key and a model endpoint has no legitimate reason to redirect — a
    // 3xx here is either a misconfigured baseUrl or an attempt to replay the
    // key elsewhere, so refuse to follow rather than follow-and-strip.
    const res = await egressGuardedFetch(
      url,
      { ...init, signal: AbortSignal.timeout(10_000) },
      { maxRedirects: 0, logger },
    );
    return { ok: true, res, latency: Math.round(performance.now() - start) };
  } catch (err) {
    const latency = Math.round(performance.now() - start);
    // Guard verdicts map to the same structured results the routes already
    // return — never the resolved host/address (`checkEgressUrl` above sets
    // the precedent: the block reason stays server-side).
    if (err instanceof SsrfBlockedError) {
      if (err.reason === "too-many-redirects") {
        // `maxRedirects: 0` — the endpoint answered with a 3xx we refuse to
        // follow (the request carries the API key). Surface it as a provider
        // problem, not a blocked network.
        return {
          ok: false,
          latency,
          error: "PROVIDER_ERROR",
          message: "Provider endpoint redirected; use the final URL as base URL",
        };
      }
      return { ok: false, latency, error: "BLOCKED_URL", message: "URL targets a blocked network" };
    }
    return { ...mapFetchErrorToTestResult(err, latency), ok: false };
  }
}

function buildInferenceProbeRequest(config: { baseUrl: string; apiKey: string; modelId: string }): {
  url: string;
  init: Omit<RequestInit, "signal">;
} {
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    },
  };
}

/** A provider status that failed the test: the key refused, throttled, or the provider erred. */
export function statusFailure(status: number, latency: number): TestResult & { ok: false } {
  if (status === 401 || status === 403) {
    return { ok: false, latency, error: "AUTH_FAILED", message: "Authentication failed", status };
  }
  if (status === 429) {
    return { ok: false, latency, error: "RATE_LIMITED", message: "Rate limited", status };
  }
  return {
    ok: false,
    latency,
    error: "PROVIDER_ERROR",
    message: `Provider returned ${status}`,
    status,
  };
}

/**
 * Model the key probe calls: the first id of the live listing that the offer
 * serves (a model the vendor retired must not fail every key), else the first
 * featured id, else the first offered one.
 */
function probeModelId(def: ModelProviderDefinition, listedIds: readonly string[] | null): string {
  const offered = listCatalogModels(def).map((m) => m.id);
  const offeredSet = new Set(offered);
  return listedIds?.find((id) => offeredSet.has(id)) ?? def.featuredModels[0] ?? offered[0]!;
}

/**
 * Key check of a `publicModelListing` provider: one minimal chat completion on
 * {@link probeModelId}. `listedIds` is the listing already read, if any. Any
 * status below 500 but 401/403/429 passes (a model may 400 `max_tokens: 1`).
 */
export async function validateKeyByInference(
  def: ModelProviderDefinition,
  config: { baseUrl: string; apiKey: string },
  listedIds?: readonly string[],
): Promise<TestResult> {
  const listed =
    listedIds ??
    (await listedModelIds({ ...config, apiShape: def.apiShape, providerId: def.providerId }));
  const { url, init } = buildInferenceProbeRequest({
    ...config,
    modelId: probeModelId(def, listed),
  });
  const reply = await guardedProviderFetch(config.baseUrl, url, init);
  if (!reply.ok) return reply;
  const { res, latency } = reply;
  await res.body?.cancel();
  const accepted = ![401, 403, 429].includes(res.status) && res.status < 500;
  return accepted ? { ok: true, latency, status: res.status } : statusFailure(res.status, latency);
}

/** Test a model config directly (no DB lookup). */
export async function testModelConfig(config: {
  apiShape: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  providerId?: string;
  accountId?: string;
  /** OAuth only — token expiry (epoch ms). Used by the offline credential check. */
  expiresAt?: number | null;
}): Promise<TestResult> {
  // Provider-agnostic OFFLINE credential validation — a provider that ships a
  // `validateCredential` hook (subscription providers: codex, claude-code) is
  // validated locally, so the platform NEVER issues an API call to test its
  // tokens. The mere PRESENCE of the hook is the signal — there is no separate
  // flag to keep in sync. The module decodes the token locally; we map its
  // pure-data result to a TestResult (latency 0 — no request was made). Returns
  // BEFORE the SSRF/network branch.
  const provider = config.providerId ? getModelProvider(config.providerId) : null;
  if (provider?.hooks?.validateCredential) {
    const result = provider.hooks.validateCredential({
      apiKey: config.apiKey,
      accountId: config.accountId,
      expiresAt: config.expiresAt,
    });
    return result.ok
      ? { ok: true, latency: 0 }
      : { ok: false, latency: 0, error: result.error, message: result.message };
  }
  // A listing that answers any key cannot test one.
  if (provider?.publicModelListing) return validateKeyByInference(provider, config);
  const reply = await fetchModelListing(config);
  if (!reply.ok) return reply;
  const { res, latency } = reply;
  return res.ok ? { ok: true, latency, status: res.status } : statusFailure(res.status, latency);
}

/** Test a saved model by ID (loads from DB/system registry then delegates to testModelConfig). */
function needsReconnectionTestResult(): TestResult {
  return {
    ok: false,
    latency: 0,
    error: "NEEDS_RECONNECTION",
    message:
      "This model's provider credential must be reconnected before it can be tested. Reconnect it in the Model Provider Keys tab.",
  };
}

export async function testModelConnection(orgId: string, modelDbId: string): Promise<TestResult> {
  const model = await loadModel(orgId, modelDbId, null);
  if (!model) {
    // A dead-credential model is LISTED (flagged) while `loadModel` still
    // refuses it, and the settings table offers "Test" on every listed row —
    // so this is reached with the row on screen in front of the user. Answer
    // with the surface's normal failed result: the route turns only
    // `MODEL_NOT_FOUND` into a 404, and "Model not found" is the one thing
    // that is demonstrably untrue here.
    if (await modelNeedsReconnection(orgId, modelDbId)) {
      return needsReconnectionTestResult();
    }
    return { ok: false, latency: 0, error: "MODEL_NOT_FOUND", message: "Model not found" };
  }

  // The test spends the organization's binding: a model no credential serves cannot be tested.
  requireBoundModel(model, null);

  // An expired OAuth access token is not terminal while its refresh token may
  // still work. Saved models carry a credential id, so use the canonical
  // resolver before the provider's offline validation; it rotates recoverable
  // tokens and persists needsReconnection on missing/revoked refresh tokens.
  if (model.credentialId && getModelProvider(model.providerId)?.authMode === "oauth2") {
    try {
      const token = await resolveOAuthTokenForSidecar(model.credentialId, orgId);
      return testModelConfig({
        ...model,
        apiKey: token.accessToken,
        accountId: token.accountId ?? model.accountId,
        expiresAt: token.expiresAt,
      });
    } catch (err) {
      // The resolver owns the terminal/non-terminal policy. Read its persisted
      // verdict instead of coupling this surface to every terminal error code;
      // this also catches a transient-failure streak that just escalated.
      if (await modelNeedsReconnection(orgId, modelDbId)) {
        return needsReconnectionTestResult();
      }
      throw err;
    }
  }

  return testModelConfig(model);
}

// OSS supports only the API-key flow for Anthropic, via the `anthropic`
// provider in the `core-providers` module. Anthropic Consumer ToS forbids
// using OAuth subscription tokens in any third-party product, so OSS
// ships no Anthropic OAuth provider.
