// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import { lookupCatalogModel } from "./pricing-catalog.ts";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { notFound } from "../lib/errors.ts";
import { checkEgressUrl } from "../lib/egress-host-guard.ts";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import type { ModelMetadata, OrgModelInfo, TestResult } from "@appstrate/shared-types";
import {
  loadInferenceCredentials,
  loadCredentialRow,
  loadCredentialMetadata,
} from "./model-providers/credentials.ts";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import {
  getResolvedModel,
  setResolvedModel,
  invalidateResolvedModel,
} from "./resolved-model-cache.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  mergeSystemAndDb,
  buildUpdateSet,
  scopedWhere,
  createDefaultPointer,
  isInvalidTextRepresentation,
} from "../lib/db-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";
import { getModelProvider } from "./model-providers/registry.ts";

// --- Metadata projection ---

/**
 * Project the 6 metadata fields (label + 5 capability/cost fields) by
 * cascading source → catalog defaults → final fallback. This is the single
 * authoritative place where overrides beat the vendored catalog — cost-shape
 * changes touch exactly one function.
 *
 * Used by every site that reads {@link ModelMetadata}: the wire-shape
 * projection (`listOrgModels` for both system and DB rows), and the resolved-
 * model builders for the run executor (`buildSystemResolvedModel`,
 * `buildDbResolvedModel`).
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
 * Strip the real binding from a model alias before it reaches a user-facing
 * surface. For `aliased` entries the public `id`/`label` survive (the user
 * selected the alias) but the backing — provider/protocol (`apiShape`),
 * endpoint (`baseUrl`), upstream id (`modelId`), credential, and every
 * capability/cost field — is nulled. Capability/cost are dropped too (not just
 * the ids): the unstripped values are catalog-derived from the *real* model and
 * would themselves identify it (a distinctive context window or price reveals
 * the backing). Non-aliased models pass through untouched.
 *
 * Applied at the user-facing read boundary (`GET /api/models`, the effective-
 * default response) — NOT inside {@link listOrgModels}, so the operator
 * create/update handlers (which re-project via {@link getOrgModel}) still see
 * the full resource they just configured. Resolution (`resolveModel` /
 * `loadModel`) is unaffected — the run executor always gets the real binding.
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
    providerName: null,
    baseUrl: null,
    modelId: null,
    credentialId: null,
    // Capability/cost — catalog-derived from the REAL model, so they
    // fingerprint it; drop them too.
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    cost: null,
  };
}

// --- List (system + DB) ---

export async function listOrgModels(
  orgId: string,
  opts?: { metadataOnly?: boolean },
): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const rows = await db.select().from(orgModels).where(scopedWhere(orgModels, { orgId }));
  // The default is an org-level pointer: when set, exactly that id is the
  // default (system or custom); when null, the system-flagged model wins.
  const pointer = await defaultModel.getDefaultId(orgId);
  const now = toISORequired(new Date());

  // Resolve apiShape/providerId/baseUrl per row (the DB row no longer stores
  // them — they derive from the credential's `providerId`). Two modes:
  //   - default: decrypt each credential (`loadInferenceCredentials`); a row
  //     with an unreachable credential (deleted upstream, dead OAuth, decrypt
  //     failure) is dropped — surfacing it would confuse the UI.
  //   - metadataOnly: resolve from the registry WITHOUT touching the secret
  //     (`loadCredentialMetadata`). Skips the decrypt for callers that only need
  //     the protocol family (e.g. the chat model picker); the real secret is
  //     resolved later at inference time. A row whose credential/provider is
  //     gone is still dropped. mapRow below reads only providerId/apiShape/
  //     baseUrl, so both resolvers feed it the same shape.
  const credByRow = new Map<
    string,
    { providerId: string; apiShape: ModelApiShape; baseUrl: string }
  >();
  await Promise.all(
    rows.map(async (r) => {
      const creds = opts?.metadataOnly
        ? await loadCredentialMetadata(r.credentialId, orgId)
        : await loadInferenceCredentials(orgId, r.credentialId);
      if (!creds) return;
      // `metadataOnly` skips the decrypt, so it cannot see the OAuth blob's
      // `needsReconnection` flag — a dead OAuth credential would otherwise
      // leak into the model picker as a selectable (but unusable) model.
      // Route OAuth rows through the decrypt gate (`loadInferenceCredentials`
      // returns null for dead credentials), matching the default listing.
      // api-key credentials can never be "dead", so they skip this probe.
      if (opts?.metadataOnly && getModelProvider(creds.providerId)?.authMode === "oauth2") {
        const live = await loadInferenceCredentials(orgId, r.credentialId);
        if (!live) return;
      }
      credByRow.set(r.id, creds);
    }),
  );
  const reachableRows = rows.filter((r) => credByRow.has(r.id));

  return mergeSystemAndDb<ModelDefinition, (typeof reachableRows)[number], OrgModelInfo>({
    system,
    rows: reachableRows,
    mapSystem: (id, def): OrgModelInfo => ({
      id,
      ...resolveModelMetadata(
        def,
        def.modelId,
        resolveCatalogDefaults(def.providerId, def.modelId),
      ),
      apiShape: def.apiShape,
      providerId: def.providerId,
      providerName: getModelProvider(def.providerId)?.displayName ?? null,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      enabled: def.enabled !== false,
      is_default: pointer !== null ? id === pointer : def.isDefault === true,
      aliased: def.aliased === true,
      iconUrl: def.iconUrl ?? null,
      source: "built-in",
      credentialId: def.credentialId,
      created_by: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row): OrgModelInfo => {
      const creds = credByRow.get(row.id)!;
      return {
        id: row.id,
        ...resolveModelMetadata(
          { ...row, input: row.input as string[] | null, cost: row.cost as ModelCost | null },
          row.modelId,
          resolveCatalogDefaults(creds.providerId, row.modelId),
        ),
        apiShape: creds.apiShape,
        providerId: creds.providerId,
        providerName: getModelProvider(creds.providerId)?.displayName ?? null,
        baseUrl: creds.baseUrl,
        modelId: row.modelId,
        enabled: row.enabled,
        is_default: pointer !== null && row.id === pointer,
        aliased: row.aliased,
        // DB custom models declare no icon — the client resolves it from the
        // (visible) apiShape/baseUrl. Aliases live in env, never this table.
        iconUrl: null,
        source: row.source as "custom" | "built-in",
        credentialId: row.credentialId,
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
 * byte-for-byte). Returns `undefined` when the id is unknown or its backing
 * credential is unreachable (the row is then absent from the list too).
 *
 * Used by the create/update handlers to return the full resource instead of an
 * id-only stub (issue #646). Deliberately re-runs `listOrgModels` rather than
 * duplicating the merge/credential-resolution logic — these lists are small
 * (per-org models) and correctness/parity beats shaving one credential lookup.
 */
export async function getOrgModel(orgId: string, id: string): Promise<OrgModelInfo | undefined> {
  const all = await listOrgModels(orgId);
  return all.find((m) => m.id === id);
}

/**
 * Raw custom-model row fetch — NO credential resolution, NO reachability
 * filtering. {@link getOrgModel} deliberately drops rows whose backing
 * credential is unreachable, which makes it unusable as the *pre-state* read
 * for update-time invariant checks (a row must be inspectable even when its
 * credential is dead). Exposes exactly the three fields the alias invariants
 * need. System (env) models are not rows — callers gate on `isSystemModel`
 * first.
 */
export async function getOrgModelRow(
  orgId: string,
  id: string,
): Promise<{ label: string; credentialId: string; aliased: boolean } | undefined> {
  const [row] = await db
    .select({
      label: orgModels.label,
      credentialId: orgModels.credentialId,
      aliased: orgModels.aliased,
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
): Promise<string> {
  const defaults = resolveCatalogDefaults(providerId, modelId);
  const base = defaults.label ?? modelId;
  const rows = await db
    .select({ label: orgModels.label })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId }));
  return dedupeLabel(
    base,
    rows.map((r) => r.label),
  );
}

// --- CRUD (DB models only) ---

export async function createOrgModel(
  orgId: string,
  label: string,
  modelId: string,
  userId: string,
  credentialId: string,
  capabilities?: {
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    cost?: ModelCost;
    aliased?: boolean;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(orgModels)
      .values({
        orgId,
        label,
        modelId,
        credentialId,
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
}

export async function updateOrgModel(
  orgId: string,
  modelDbId: string,
  data: {
    label?: string;
    modelId?: string;
    enabled?: boolean;
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
    credentialId?: string;
    aliased?: boolean;
  },
): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot modify built-in model");
  }

  // Keys of `updateModelSchema` (routes/models.ts).
  const updates = buildUpdateSet(data, [
    "label",
    "modelId",
    "credentialId",
    "enabled",
    "input",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "cost",
    "aliased",
  ]);

  await db
    .update(orgModels)
    .set(updates)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
  // Drop the cached resolution (modelId/enabled/credential/cost may have changed).
  invalidateResolvedModel(orgId, modelDbId);
}

export async function deleteOrgModel(orgId: string, modelDbId: string): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot delete built-in model");
  }
  await db
    .delete(orgModels)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
  invalidateResolvedModel(orgId, modelDbId);
  // If the deleted model was the org default, clear the now-dangling pointer so
  // the resolver falls cleanly to the system cascade (no stale-id badge).
  await defaultModel.clearDanglingPointer(orgId, modelDbId);
}

/**
 * Atomically seed multiple catalog models for a single credential. Called by
 * the onboarding quick-connect flow right after a pairing succeeds — replaces
 * N client-side POST /models calls.
 *
 * Skips entirely if the org already has any model bound to the credential
 * (idempotent for re-connect flows). Promotes the first newly-created row to
 * default when the org has no default yet.
 *
 * Models are taken verbatim from {@link CatalogModelEntry}. The provider's
 * `apiShape` and `baseUrl` are resolved from the registry by the credential's
 * `providerId` at read time — no need to pass them through here.
 */
export interface SeedModelsResult {
  created: number;
  ids: string[];
  promotedDefault: boolean;
}

export interface SeedModelsInput {
  models: ReadonlyArray<CatalogModelEntry & { id: string }>;
}

export async function seedOrgModelsForCredential(
  orgId: string,
  userId: string,
  credentialId: string,
  input: SeedModelsInput,
): Promise<SeedModelsResult> {
  if (input.models.length === 0) return { created: 0, ids: [], promotedDefault: false };

  return db.transaction(async (tx) => {
    // Dedup: skip if any model already references this credential.
    const existingForCred = await tx
      .select({ id: orgModels.id })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.credentialId, credentialId)] }))
      .limit(1);
    if (existingForCred.length > 0) {
      return { created: 0, ids: [], promotedDefault: false };
    }

    // Store catalog-derivable columns as null — read path falls back to
    // the live catalog via `resolveCatalogDefaults`, so a weekly catalog
    // refresh propagates to these rows without a backfill migration.
    // Only `label` is materialised (DB column is NOT NULL); explicit
    // user-side renames remain stable across catalog bumps.
    const inserted = await tx
      .insert(orgModels)
      .values(
        input.models.map((m) => ({
          orgId,
          label: m.label,
          modelId: m.id,
          credentialId,
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

    // Promote the first seeded model to the org default when none is set yet —
    // via the pointer helper, so the `defaultModelId` field name stays owned in
    // one place (db-helpers) rather than re-hardcoded here.
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
 * per-row flag flip — so there is nothing to keep transactionally consistent.
 */
export async function setDefaultModel(orgId: string, modelDbId: string | null): Promise<void> {
  // Validate the target before storing it (mirrors the integration set-default
  // guard). A system id is trusted via the registry; a custom id must be a row
  // the org owns.
  await defaultModel.setDefault(orgId, modelDbId);
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
   * Always set — the builders fall back to the catalog and finally `modelId`
   * so callers can read it as a plain string even when the env entry or DB
   * row omitted it. `ModelDefinition.label` stays optional on purpose
   * (storage-side) — `ResolvedModel.label` is its post-resolution view.
   */
  label: string;
  /** Whether the model comes from SYSTEM_PROVIDER_KEYS (platform-provided). */
  isSystemModel: boolean;
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
   * `extractTokenIdentity` hook — echoed by the sidecar as a routing
   * header at request time (e.g. `chatgpt-account-id` for Codex).
   */
  accountId?: string;
  /** `model_provider_credentials` row id — passed to the sidecar so it can pull fresh OAuth tokens at request time. Unset for system (env-driven) keys. */
  credentialId?: string;
}

interface DbOrgModelRow {
  id: string;
  modelId: string;
  credentialId: string;
  label: string;
  input: unknown;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  cost: unknown;
  aliased: boolean;
}

interface DbModelCredentials {
  apiKey: string;
  providerId: string;
  apiShape: string;
  baseUrl: string;
  accountId?: string;
}

/**
 * Catalog-derived defaults for `(providerId, modelId)`. Each `org_models`
 * column is an *optional override* — when the row stores null, the catalog
 * value flows through here. Storing nulls instead of frozen catalog values
 * lets the weekly `refresh-pricing-catalog.ts` bump propagate to existing
 * rows. Honors `catalogProviderId` so OAuth wrappers (codex → openai,
 * claude-code → anthropic) hit the right catalog file.
 *
 * Returns `{}` on any miss (unmapped provider, unknown model id, dropped
 * entry). Callers fall through to row values or final defaults.
 */
export interface CatalogDefaults {
  label?: string;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number | null;
  reasoning?: boolean;
  cost?: ModelCost;
}

export function resolveCatalogDefaults(providerId: string, modelId: string): CatalogDefaults {
  const provider = getModelProvider(providerId);
  const catalogKey = provider?.catalogProviderId ?? providerId;
  const entry = lookupCatalogModel(catalogKey, modelId);
  if (!entry) return {};
  return {
    label: entry.label,
    input: entry.capabilities.filter((c): c is "text" | "image" => c === "text" || c === "image"),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.capabilities.includes("reasoning"),
    cost: entry.cost,
  };
}

/** Build a `ResolvedModel` from a system `ModelDefinition` (env-driven). */
function buildSystemResolvedModel(def: ModelDefinition): ResolvedModel {
  return {
    providerId: def.providerId,
    apiShape: def.apiShape,
    baseUrl: def.baseUrl,
    modelId: def.modelId,
    apiKey: def.apiKey,
    ...resolveModelMetadata(def, def.modelId, resolveCatalogDefaults(def.providerId, def.modelId)),
    isSystemModel: true,
    aliased: def.aliased === true,
    aliasId: def.id,
  };
}

/** Build a `ResolvedModel` from a DB `org_models` row + its credentials.
 *
 * `apiShape` and `baseUrl` come straight from the credential — the credential
 * service resolves them from the registry by `providerId` (with the per-row
 * `baseUrlOverride` honored when `baseUrlOverridable: true`). Every catalog-
 * derivable column on `org_models` is an optional override that defers to
 * the catalog on null — so a weekly catalog refresh propagates to existing
 * rows.
 */
function buildDbResolvedModel(row: DbOrgModelRow, creds: DbModelCredentials): ResolvedModel {
  return {
    providerId: creds.providerId,
    apiShape: creds.apiShape,
    baseUrl: creds.baseUrl,
    modelId: row.modelId,
    apiKey: creds.apiKey,
    ...resolveModelMetadata(
      { ...row, input: row.input as string[] | null, cost: row.cost as ModelCost | null },
      row.modelId,
      resolveCatalogDefaults(creds.providerId, row.modelId),
    ),
    isSystemModel: false,
    aliased: row.aliased,
    aliasId: row.id,
    accountId: creds.accountId,
    credentialId: row.credentialId,
  };
}

export async function resolveModel(
  orgId: string,
  packageId: string,
  modelId: string | null,
): Promise<ResolvedModel | null> {
  // 1. Explicit override (agent column or per-run)
  if (modelId) {
    const result = await loadModel(orgId, modelId);
    if (result) return result;
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
    const resolved = await loadModel(orgId, pointer);
    if (resolved) return resolved;
  }

  // 3. System default
  const system = getSystemModels();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return buildSystemResolvedModel(def);
    }
  }

  // 4. No model configured
  return null;
}

export async function loadModel(orgId: string, modelDbId: string): Promise<ResolvedModel | null> {
  // Check system models first
  const system = getSystemModels();
  const systemDef = system.get(modelDbId);
  if (systemDef) {
    return buildSystemResolvedModel(systemDef);
  }

  // Short-TTL cache (see resolved-model-cache.ts). Only the successful (non-null)
  // DB result is cached; system models are already in-memory. Invalidated
  // eagerly by model + credential mutators, so the TTL is a backstop.
  const cached = getResolvedModel(orgId, modelDbId);
  if (cached) return cached;

  // Check DB. `orgModels.id` is a `uuid` column — a `modelDbId` that isn't a
  // valid UUID (e.g. a human-readable model name like `gpt-5.5`) makes Postgres
  // raise `invalid input syntax for type uuid` rather than returning no rows.
  // Normalise that one cast failure into "not found" (null) so callers see a
  // clean 4xx instead of a 500; rethrow any other error (e.g. a real DB outage)
  // rather than masking it as a missing model. Same hazard handled in
  // `llm-proxy/core.ts`.
  let row: (DbOrgModelRow & { enabled: boolean }) | undefined;
  try {
    [row] = await db
      .select({
        id: orgModels.id,
        modelId: orgModels.modelId,
        credentialId: orgModels.credentialId,
        enabled: orgModels.enabled,
        label: orgModels.label,
        input: orgModels.input,
        contextWindow: orgModels.contextWindow,
        maxTokens: orgModels.maxTokens,
        reasoning: orgModels.reasoning,
        cost: orgModels.cost,
        aliased: orgModels.aliased,
      })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
      .limit(1);
  } catch (err) {
    // `22P02` = invalid_text_representation (the uuid cast failure).
    if (isInvalidTextRepresentation(err)) return null;
    throw err;
  }

  if (!row || !row.enabled) return null;

  const creds = await loadInferenceCredentials(orgId, row.credentialId);
  if (!creds) return null;

  const resolved = buildDbResolvedModel(row, creds);
  setResolvedModel(orgId, modelDbId, resolved);
  return resolved;
}

/**
 * Disambiguate the `loadModel(...) === null` result for an org (DB) model: is it
 * null because the model is missing/disabled, or because its OAuth credential is
 * flagged `needsReconnection` (which `loadInferenceCredentials` treats as dead)?
 *
 * Returns `true` only for the second case — an enabled DB model whose OAuth
 * credential needs reconnection — so a caller can surface an actionable
 * "reconnect" instead of a misleading "not found / not enabled". System models
 * and non-UUID ids are never reconnection cases (`false`).
 */
export async function modelNeedsReconnection(orgId: string, modelDbId: string): Promise<boolean> {
  if (isSystemModel(modelDbId)) return false;

  let row: { credentialId: string; enabled: boolean } | undefined;
  try {
    [row] = await db
      .select({ credentialId: orgModels.credentialId, enabled: orgModels.enabled })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
      .limit(1);
  } catch (err) {
    // Same non-UUID cast hazard `loadModel` guards against → treat as "no".
    if (isInvalidTextRepresentation(err)) return false;
    throw err;
  }
  if (!row || !row.enabled || !row.credentialId) return false;

  const cred = await loadCredentialRow(row.credentialId, orgId);
  return !!cred && cred.blob.kind === "oauth" && !!cred.blob.needsReconnection;
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
): Promise<void> {
  if (!modelId) return;
  const model = await loadModel(orgId, modelId);
  if (!model) {
    throw notFound(`Model '${modelId}' not found — expected a model UUID or a system model key`);
  }
}

// --- Connection test ---

/** Build the discovery URL + headers used to probe a model provider. Pure for unit testing. */
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
    case "google-generative-ai":
      url = `${base}/models?key=${encodeURIComponent(config.apiKey)}`;
      break;
    case "google-vertex":
      url = `${base}/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
    case "azure-openai-responses":
      url = `${base}/models`;
      headers["api-key"] = config.apiKey;
      break;
    case "openai-completions":
    case "openai-responses":
    case "bedrock-converse-stream":
    default:
      url = `${base}/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
  }

  return { url, headers };
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

  // Canonical egress guard (parse + scheme floor + allowlist-aware literal +
  // DNS-rebind host gate) before the test fetch: a public hostname resolving to
  // a private/loopback/link-local address is refused, fail-closed, with the
  // same BLOCKED_URL result (the resolution reason is never surfaced).
  const egress = await checkEgressUrl(config.baseUrl);
  if (!egress.ok) {
    return {
      ok: false,
      latency: 0,
      error: "BLOCKED_URL",
      message: "URL targets a blocked network",
    };
  }

  const { url, headers } = buildModelTestRequest(config);

  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Math.round(performance.now() - start);

    if (res.ok) return { ok: true, latency, status: res.status };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latency,
        error: "AUTH_FAILED",
        message: "Authentication failed",
        status: res.status,
      };
    }
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Provider returned ${res.status}`,
      status: res.status,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}

/** Test a saved model by ID (loads from DB/system registry then delegates to testModelConfig). */
export async function testModelConnection(orgId: string, modelDbId: string): Promise<TestResult> {
  const model = await loadModel(orgId, modelDbId);
  if (!model)
    return { ok: false, latency: 0, error: "MODEL_NOT_FOUND", message: "Model not found" };

  return testModelConfig(model);
}

// OSS supports only the API-key flow for Anthropic, via the `anthropic`
// provider in the `core-providers` module. Anthropic Consumer ToS forbids
// using OAuth subscription tokens in any third-party product, so OSS
// ships no Anthropic OAuth provider.
