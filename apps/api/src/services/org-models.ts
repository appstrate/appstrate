// SPDX-License-Identifier: Apache-2.0

import { and, eq, getTableColumns } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, orgModels, type CredentialSource } from "@appstrate/db/schema";
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
import { ApiError, conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { checkEgressUrl, egressGuardedFetch } from "../lib/egress-host-guard.ts";
import { SsrfBlockedError } from "@appstrate/core/ssrf";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import type { ModelMetadata, OrgModelInfo, TestResult } from "@appstrate/shared-types";
import {
  loadCredentialMetadata,
  loadInferenceCredentials,
  personalModelCredentialsAllowed,
} from "./model-providers/credentials.ts";
import {
  applicableCredentialIds,
  isSubscription,
  listPersonalCredentials,
  servesModel,
  type PersonalCredential,
} from "./model-providers/credential-chain.ts";
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
    credentialId: null,
    // The label names the backing credential, so it stays private; `billed_to`
    // names only the payer side.
    credential_label: null,
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

// --- List (system + DB) ---

/** What a DB row's binding is served with, read through its credential. */
interface RowBinding {
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  needsReconnection: boolean;
  /** The bound credential serves inference now. */
  usable: boolean;
}

/**
 * The binding of a DB row, through ONE predicate for every row:
 *
 *   `loadInferenceCredentials(...) === null`
 *
 * That is the FLAG predicate: a row whose credential no longer serves inference
 * (revoked OAuth grant, a blob that no longer decrypts, a key rotated away) is
 * listed flagged, not dropped. An unbound row serves no credential: it is listed
 * with its provider's fixed endpoint. `null` (a credential row gone, or a provider
 * with no registry entry) drops the row — with no provider there is nothing to render.
 */
async function describeRowBinding(
  orgId: string,
  row: { credentialId: string | null; providerId: string },
): Promise<RowBinding | null> {
  if (row.credentialId === null) {
    const def = getModelProvider(row.providerId);
    return def
      ? {
          providerId: row.providerId,
          apiShape: def.apiShape,
          baseUrl: def.defaultBaseUrl,
          needsReconnection: false,
          usable: false,
        }
      : null;
  }
  // A key missing from the keyring (logged) leaves the row shown as it is, not the list a 503.
  let live: Awaited<ReturnType<typeof loadInferenceCredentials>> = null;
  let keyUnavailable = false;
  try {
    live = await loadInferenceCredentials(orgId, row.credentialId);
  } catch (err) {
    if (!(err instanceof EncryptionKeyUnavailableError)) throw err;
    keyUnavailable = true;
  }
  if (live) {
    return {
      providerId: live.providerId,
      apiShape: live.apiShape,
      baseUrl: live.baseUrl,
      needsReconnection: false,
      usable: true,
    };
  }
  const raw = await loadCredentialMetadata(row.credentialId, orgId);
  if (!raw) return null;
  return {
    providerId: raw.providerId,
    apiShape: raw.apiShape,
    baseUrl: raw.baseUrl,
    needsReconnection: !keyUnavailable,
    usable: false,
  };
}

/**
 * A personal credential's inference material. A blob whose key this process lacks
 * reads as not serving (logged), so the chain falls through to the next credential
 * or the org binding instead of answering a 503.
 */
async function loadPersonalInference(orgId: string, credentialId: string) {
  try {
    return await loadInferenceCredentials(orgId, credentialId);
  } catch (err) {
    if (!(err instanceof EncryptionKeyUnavailableError)) throw err;
    logger.warn("Personal model credential skipped: its encryption key is not in the keyring", {
      credentialId,
    });
    return null;
  }
}

/** The payer's own credentials that may serve `target`, best first; none for an alias. */
async function payerCredentialIds(
  orgId: string,
  payerUserId: string | null,
  target: { providerId: string; modelId: string; aliased?: boolean },
  options?: { excludeSubscriptions?: boolean },
): Promise<string[]> {
  if (!payerUserId || target.aliased) return [];
  return applicableCredentialIds(
    await listPersonalCredentials(orgId, payerUserId),
    target,
    options,
  );
}

/** Whose credential serves a model for the caller: its own when one applies (as resolution picks it), else the org's binding. */
async function billedTo(
  isServing: (credentialId: string) => Promise<boolean>,
  personal: readonly PersonalCredential[],
  target: { providerId: string; modelId: string; aliased: boolean },
  orgUsable: boolean,
): Promise<"user" | "org" | null> {
  if (!target.aliased) {
    for (const credentialId of applicableCredentialIds(personal, target)) {
      if (await isServing(credentialId)) return "user";
    }
  }
  return orgUsable ? "org" : null;
}

export async function listOrgModels(
  orgId: string,
  payerUserId: string | null,
): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const rows = await db
    .select({ ...getTableColumns(orgModels), credentialLabel: modelProviderCredentials.label })
    .from(orgModels)
    .leftJoin(modelProviderCredentials, eq(modelProviderCredentials.id, orgModels.credentialId))
    .where(scopedWhere(orgModels, { orgId }));
  // The default is an org-level pointer: when set, exactly that id is the
  // default (system or custom); when null, the system-flagged model wins.
  const pointer = await defaultModel.getDefaultId(orgId);
  const now = toISORequired(new Date());

  const bindings = new Map<string, RowBinding>();
  await Promise.all(
    rows.map(async (r) => {
      const binding = await describeRowBinding(orgId, r);
      if (binding) bindings.set(r.id, binding);
    }),
  );
  // "renderable", not "reachable": a dead-credential row is kept (flagged) —
  // only a row with no resolvable provider is dropped.
  const renderableRows = rows.filter((r) => bindings.has(r.id));

  const personal = payerUserId ? await listPersonalCredentials(orgId, payerUserId) : [];
  // A personal credential is read once per call, however many models it applies to.
  const servingNow = new Map<string, Promise<boolean>>();
  const isServing = (credentialId: string): Promise<boolean> => {
    let served = servingNow.get(credentialId);
    if (!served) {
      served = loadPersonalInference(orgId, credentialId).then((creds) => creds !== null);
      servingNow.set(credentialId, served);
    }
    return served;
  };
  const billing = new Map<string, "user" | "org" | null>();
  await Promise.all([
    ...Array.from(system, async ([id, def]) => {
      billing.set(
        id,
        await billedTo(
          isServing,
          personal,
          { providerId: def.providerId, modelId: def.modelId, aliased: def.aliased === true },
          true,
        ),
      );
    }),
    ...renderableRows.map(async (r) => {
      const binding = bindings.get(r.id)!;
      billing.set(
        r.id,
        await billedTo(
          isServing,
          personal,
          { providerId: binding.providerId, modelId: r.modelId, aliased: r.aliased },
          binding.usable,
        ),
      );
    }),
  ]);

  return mergeSystemAndDb<ModelDefinition, (typeof renderableRows)[number], OrgModelInfo>({
    system,
    rows: renderableRows,
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
        credentialId: def.credentialId,
        credential_label: null,
        billed_to: billing.get(id) ?? null,
        created_by: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    mapRow: (row): OrgModelInfo => {
      const binding = bindings.get(row.id)!;
      const defaults = resolveCatalogDefaults(binding.providerId, row.modelId);
      const metadata = resolveModelMetadata(row, row.modelId, defaults);
      return {
        id: row.id,
        ...metadata,
        generation: generationOf(defaults, {
          providerId: binding.providerId,
          apiShape: binding.apiShape,
          reasoning: metadata.reasoning,
          aliased: row.aliased,
        }),
        apiShape: binding.apiShape,
        providerId: binding.providerId,
        provider_name: getModelProvider(binding.providerId)?.displayName ?? null,
        pi_provider: resolvePiProvider(binding.providerId),
        pi_dialect: resolvePiDialect(binding.providerId, row.modelId),
        base_url: binding.baseUrl,
        modelId: row.modelId,
        enabled: row.enabled,
        is_default: pointer !== null && row.id === pointer,
        // For the caller, like `billed_to`: a dead organization credential does not
        // make the model unusable to a member whose own credential serves it.
        needs_reconnection: binding.needsReconnection && billing.get(row.id) !== "user",
        aliased: row.aliased,
        // DB custom models declare no icon — the client resolves it from the
        // (visible) apiShape/baseUrl. Aliases live in env, never this table.
        iconUrl: null,
        source: row.source as "custom" | "built-in",
        credentialId: row.credentialId,
        credential_label: row.credentialLabel,
        billed_to: billing.get(row.id) ?? null,
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
 * id-only stub (issue #646). Deliberately re-runs `listOrgModels` rather than
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
): Promise<
  | {
      label: string;
      providerId: string;
      credentialId: string | null;
      aliased: boolean;
      modelId: string;
      contextWindow: number | null;
      maxTokens: number | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      label: orgModels.label,
      providerId: orgModels.providerId,
      credentialId: orgModels.credentialId,
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

/**
 * The loser of a duplicate add — the caller re-sending the same body, or two of
 * the multi-add path's sequential POSTs racing — gets a 409 naming the row that
 * already holds the binding, not a 500 carrying an index name. The database is
 * the only arbiter: a read-then-insert check would reopen the same window
 * `uq_org_models_unaliased_binding` exists to close.
 */
async function asDuplicateBinding(
  err: unknown,
  orgId: string,
  binding: { credentialId: string | null; providerId: string },
  modelId: string,
): Promise<never> {
  // Only a bound model can collide: unbound rows may repeat (script 0042 unbinds
  // models that were bound to distinct subscriptions of one provider).
  if (!isUniqueViolation(err) || binding.credentialId === null) throw err;
  const [existing] = await db
    .select({ id: orgModels.id })
    .from(orgModels)
    .where(
      scopedWhere(orgModels, {
        orgId,
        extra: [
          eq(orgModels.credentialId, binding.credentialId),
          eq(orgModels.modelId, modelId),
          // The index is partial on `aliased = false`; an alias sharing the
          // binding is legal and is never the row that refused this write.
          eq(orgModels.aliased, false),
        ],
      }),
    )
    .limit(1);
  throw conflict(
    "model_already_added",
    `Model '${modelId}' is already added for this credential`,
    existing ? { existing_model_id: existing.id } : undefined,
  );
}

/** A credential the org holds: the provider it serves, and its owner (`null` for an org credential). */
export async function loadCredentialBinding(
  orgId: string,
  credentialId: string,
): Promise<{ providerId: string; ownerUserId: string | null } | null> {
  const [row] = await db
    .select({
      providerId: modelProviderCredentials.providerId,
      ownerUserId: modelProviderCredentials.ownerUserId,
    })
    .from(modelProviderCredentials)
    .where(
      and(eq(modelProviderCredentials.id, credentialId), eq(modelProviderCredentials.orgId, orgId)),
    )
    .limit(1);
  return row ?? null;
}

function personalCredentialNotBindable(): ApiError {
  return new ApiError({
    status: 400,
    code: "personal_credential_not_bindable",
    title: "Invalid Request",
    detail:
      "A model can only be bound to an organization API key: a subscription or a member's own credential is never shared. Without one, each member serves it with their own credential.",
    param: "credentialId",
  });
}

/** How a model is bound: an org credential (its provider comes from it), or none (each member's own credential serves it, so the provider is named). */
interface ModelBindingInput {
  credentialId: string | null;
  providerId?: string;
}

async function resolveOrgBinding(
  orgId: string,
  input: ModelBindingInput,
): Promise<{ credentialId: string | null; providerId: string }> {
  if (input.credentialId === null) {
    if (!input.providerId) {
      throw invalidRequest("providerId is required for a model without a credential", "providerId");
    }
    const def = getModelProvider(input.providerId);
    if (!def) {
      throw invalidRequest(`Provider '${input.providerId}' is not registered`, "providerId");
    }
    return { credentialId: null, providerId: input.providerId };
  }
  const credential = await loadCredentialBinding(orgId, input.credentialId);
  if (!credential) throw invalidRequest("credentialId is unknown", "credentialId");
  if (credential.ownerUserId !== null || isSubscription(credential.providerId)) {
    throw personalCredentialNotBindable();
  }
  if (input.providerId !== undefined && input.providerId !== credential.providerId) {
    throw invalidRequest(
      `providerId must be '${credential.providerId}', the provider of this credential`,
      "providerId",
    );
  }
  return { credentialId: input.credentialId, providerId: credential.providerId };
}

/** A model alias is served by an org credential only: a member's own one would never be swapped in. */
function refuseUnboundAlias(aliased: boolean, credentialId: string | null): void {
  if (aliased && credentialId === null) {
    throw invalidRequest(
      "A model alias needs an organization credential: aliases never use a member's own credential",
      "credentialId",
    );
  }
}

export async function createOrgModel(
  orgId: string,
  label: string,
  modelId: string,
  userId: string,
  binding: ModelBindingInput,
  capabilities?: {
    input?: ModelInputModality[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    cost?: ModelCost;
    aliased?: boolean;
  },
): Promise<string> {
  const { credentialId, providerId } = await resolveOrgBinding(orgId, binding);
  refuseUnboundAlias(capabilities?.aliased === true, credentialId);
  // The catch sits OUTSIDE the transaction on purpose: a failed statement
  // aborts it, so `asDuplicateBinding`'s lookup could not run inside.
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(orgModels)
        .values({
          orgId,
          label,
          modelId,
          providerId,
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
  } catch (err) {
    return await asDuplicateBinding(err, orgId, { credentialId, providerId }, modelId);
  }
}

export async function updateOrgModel(
  orgId: string,
  modelDbId: string,
  data: {
    label?: string;
    modelId?: string;
    providerId?: string;
    enabled?: boolean;
    input?: ModelInputModality[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
    credentialId?: string | null;
    aliased?: boolean;
  },
): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot modify built-in model");
  }
  const current = await getOrgModelRow(orgId, modelDbId);
  if (!current) throw notFound("Model not found");

  const binding =
    data.credentialId !== undefined || data.providerId !== undefined
      ? await resolveOrgBinding(orgId, {
          credentialId: data.credentialId === undefined ? current.credentialId : data.credentialId,
          // A new org credential names its own provider; otherwise the row keeps its provider,
          // which an unbinding also keeps.
          providerId: data.providerId ?? (data.credentialId ? undefined : current.providerId),
        })
      : null;

  // Keys of `updateModelSchema` (routes/models.ts).
  const updates = {
    ...buildUpdateSet(data, [
      "label",
      "modelId",
      "enabled",
      "input",
      "contextWindow",
      "maxTokens",
      "reasoning",
      "cost",
      "aliased",
    ]),
    ...(binding ?? {}),
  };

  const rowWhere = scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] });
  try {
    await db.transaction(async (tx) => {
      // The invariants are checked on the row as locked, so two concurrent
      // patches cannot each pass on the state the other one is changing.
      const [locked] = await tx
        .select({ credentialId: orgModels.credentialId, aliased: orgModels.aliased })
        .from(orgModels)
        .where(rowWhere)
        .for("update");
      if (!locked) throw notFound("Model not found");
      refuseUnboundAlias(
        data.aliased ?? locked.aliased,
        binding ? binding.credentialId : locked.credentialId,
      );
      if (data.enabled === false) {
        // The pointer is read under the row lock `setDefaultModel` also takes
        // before checking `enabled`, so the two refusals cannot both be skipped.
        if ((await defaultModel.getDefaultId(orgId, tx)) === modelDbId) {
          throw conflict(
            "model_disabled",
            "The default model cannot be disabled. Pick another default model first, or clear the default (PUT /api/models/default with `modelId: null`).",
          );
        }
      }
      await tx.update(orgModels).set(updates).where(rowWhere);
    });
  } catch (err) {
    // Repointing a row's model or credential can land on a binding another row
    // already holds. The failed UPDATE rolled back, so the row still reads its
    // pre-edit values — merge them with the patch to name the effective binding.
    await asDuplicateBinding(
      err,
      orgId,
      binding ?? { credentialId: current.credentialId, providerId: current.providerId },
      data.modelId ?? current.modelId,
    );
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
interface SeedModelsResult {
  created: number;
  ids: string[];
  promotedDefault: boolean;
}

interface SeedModelsInput {
  models: ReadonlyArray<CatalogModelEntry & { id: string }>;
}

export async function seedOrgModelsForCredential(
  orgId: string,
  userId: string,
  credentialId: string,
  input: SeedModelsInput,
): Promise<SeedModelsResult> {
  if (input.models.length === 0) return { created: 0, ids: [], promotedDefault: false };
  // A seed is an organization binding: a member's own credential is never bound.
  const credential = await loadCredentialBinding(orgId, credentialId);
  if (!credential) throw invalidRequest("credentialId is unknown", "credentialId");
  if (credential.ownerUserId !== null) throw personalCredentialNotBindable();

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
          providerId: credential.providerId,
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
 * per-row flag flip — made under the target row's lock, the one
 * {@link updateOrgModel} takes to refuse disabling the default.
 */
export async function setDefaultModel(orgId: string, modelDbId: string | null): Promise<void> {
  // A model on a dead credential is now LISTED rather than silently dropped
  // (so it can be inspected and detached), which also puts it within a
  // client's reach here. Refuse it: the pointer feeds every run and chat, and
  // resolution of a dead model fails at inference time. The check lives in this
  // service — NOT in `createDefaultPointer`, which is shared byte-for-byte with
  // `org-proxies` and must stay generic. System ids, unknown rows and non-UUIDs
  // carry no binding, so the pointer helper below still owns the 404.
  const row = modelDbId === null ? undefined : await loadModelBinding(orgId, modelDbId);
  if (
    row?.enabled &&
    row.credentialId &&
    (await credentialIsDeadButListed(orgId, row.credentialId))
  ) {
    throw conflict(
      "model_needs_reconnection",
      "This model's provider credential must be reconnected before it can be the default model. Reconnect the credential, or pick another model.",
    );
  }
  await db.transaction(async (tx) => {
    // `resolveModel` skips a switched-off row. `enabled` is read under the row
    // lock `updateOrgModel` takes before checking the pointer, so a concurrent
    // disable is either seen here or sees this pointer.
    if (row && modelDbId !== null) {
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
  });
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
   * a customer-supplied one (`org`: an organization's or a member's own), or `null`
   * for an unbound model that no credential serves for this caller.
   */
  credentialSource: "system" | "org" | null;
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
export type BoundModel = ResolvedModel & { credentialSource: "system" | "org" };

/** What a resolved model is built from: an org row or a system definition. */
interface ModelHead extends ModelMetadata {
  id: string;
  modelId: string;
  aliased?: boolean;
}

/** An org row as the resolver reads it. */
interface DbOrgModelHead extends ModelHead {
  providerId: string;
  credentialId: string | null;
  enabled: boolean;
}

interface DbModelCredentials {
  apiKey: string;
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  accountId?: string;
}

/** The credential a resolved model is served with; no `credentialId` for an unbound model. */
interface ServingCredentials extends DbModelCredentials {
  credentialId?: string;
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
    credentialSource: serving.credentialId === undefined ? null : "org",
    aliased,
    aliasId: head.id,
    accountId: serving.accountId,
    credentialId: serving.credentialId,
  };
}

/** The model a run gets, and whether the explicit id supplied it or a default did. */
export async function resolveModelCascade(
  orgId: string,
  packageId: string,
  modelId: string | null,
  payerUserId: string | null,
): Promise<{ model: ResolvedModel; fromExplicit: boolean } | null> {
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

  // 3. System default — through loadModel, so a member's own credential applies to it too.
  for (const [id, def] of getSystemModels()) {
    if (def.isDefault && def.enabled !== false) {
      const model = await loadModel(orgId, id, payerUserId);
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
 * Refuse a model with no credential to spend: the caller has to add its own
 * credential, or an administrator has to bind an organization one.
 */
export function requireBoundModel(model: ResolvedModel): BoundModel {
  if (model.credentialSource === null) {
    const displayName = getModelProvider(model.providerId)?.displayName ?? model.providerId;
    throw conflict(
      "model_credential_required",
      `Model '${model.label}' needs a ${displayName} credential of yours: add one under Preferences → Model credentials, or ask an administrator to bind an organization credential.`,
    );
  }
  return { ...model, credentialSource: model.credentialSource };
}

/**
 * The model as the payer's own credential serves it, when one applies: personal
 * credentials come first. An aliased model never takes one.
 */
async function resolvePersonalModel(
  orgId: string,
  head: ModelHead & { providerId: string },
  payerUserId: string | null,
  excludeSubscriptions: boolean,
): Promise<ResolvedModel | null> {
  for (const credentialId of await payerCredentialIds(orgId, payerUserId, head, {
    excludeSubscriptions,
  })) {
    const creds = await loadPersonalInference(orgId, credentialId);
    if (creds) return buildResolvedModel(head, { ...creds, credentialId });
  }
  return null;
}

/**
 * Resolve a model for `payerUserId` (the user whose personal credentials may serve
 * it, or `null`: no personal credential applies). `viaProxy` is the LLM proxy's
 * chain: subscriptions are skipped, so the org binding serves it. `null` when the
 * model is missing or disabled.
 */
export async function loadModel(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null,
  options?: { viaProxy?: boolean },
): Promise<ResolvedModel | null> {
  const excludeSubscriptions = options?.viaProxy === true;
  const slot = `${payerUserId ?? ""}${excludeSubscriptions ? ":proxy" : ""}`;
  const systemDef = getSystemModels().get(modelDbId);
  if (systemDef) {
    return resolveModelCached(
      orgId,
      modelDbId,
      slot,
      async () =>
        (await resolvePersonalModel(orgId, systemDef, payerUserId, excludeSubscriptions)) ??
        buildSystemResolvedModel(systemDef),
    );
  }
  return resolveModelCached(orgId, modelDbId, slot, () =>
    resolveDbModel(orgId, modelDbId, payerUserId, excludeSubscriptions),
  );
}

/** What a run froze at launch: `runs.model_credential_id` and `runs.model_source`. */
export interface PinnedModelCredential {
  credentialId: string | null;
  source: CredentialSource | null;
}

/**
 * The credential a resolution spends, as a pin: none for a system model or an
 * alias (an alias's credential id cross-references to its backing, so it is never
 * recorded), else the credential that served it.
 */
export function credentialPin(resolved: {
  aliased?: boolean;
  credentialId?: string | null;
  credentialSource: CredentialSource | null;
}): PinnedModelCredential {
  return {
    credentialId: resolved.aliased ? null : (resolved.credentialId ?? null),
    source: resolved.credentialSource,
  };
}

export function samePin(a: PinnedModelCredential, b: PinnedModelCredential): boolean {
  return a.credentialId === b.credentialId && a.source === b.source;
}

/**
 * The model a run was launched on, served by the credential frozen at launch: no
 * chain and no payer check, since that choice was made then. `null` when the model
 * is missing or disabled, or the pinned credential no longer serves it.
 *
 * Only a system model or an alias launches without a credential id. Any other
 * unpinned run lost its credential mid-run (`ON DELETE SET NULL`), and falling
 * back to whatever serves the model now would switch who pays.
 */
export async function loadPinnedModel(
  orgId: string,
  modelDbId: string,
  pin: PinnedModelCredential,
): Promise<ResolvedModel | null> {
  const { credentialId, source } = pin;
  if (credentialId === null) {
    const resolved = await loadModel(orgId, modelDbId, null);
    const launchedUnpinned = resolved?.aliased === true || source === "system";
    return resolved && launchedUnpinned && resolved.credentialSource === source ? resolved : null;
  }
  return resolveModelCached(orgId, modelDbId, `pin:${credentialId}`, () =>
    resolvePinnedModel(orgId, modelDbId, credentialId),
  );
}

async function resolvePinnedModel(
  orgId: string,
  modelDbId: string,
  credentialId: string,
): Promise<ResolvedModel | null> {
  const systemDef = getSystemModels().get(modelDbId);
  const row = systemDef ?? (await loadOrgModelHead(orgId, modelDbId));
  if (!row || row.enabled === false) return null;
  const binding = await loadCredentialBinding(orgId, credentialId);
  if (!binding) return null;

  if (binding.ownerUserId === null) {
    // An organization credential serves only the model bound to it.
    if (systemDef || row.credentialId !== credentialId) return null;
    const creds = await loadInferenceCredentials(orgId, credentialId);
    return creds ? buildResolvedModel(row, { ...creds, credentialId }) : null;
  }
  // A personal credential serves a non-aliased model it applies to, while the
  // organization allows personal credentials: switching them off ends its runs too.
  if (row.aliased || !servesModel(binding.providerId, row)) return null;
  if (!(await personalModelCredentialsAllowed(orgId))) return null;
  const creds = await loadPersonalInference(orgId, credentialId);
  return creds ? buildResolvedModel(row, { ...creds, credentialId }) : null;
}

/** Read one org row by id. A `modelDbId` that is not a valid UUID (e.g. `gpt-5.5`) is "not found", not a 500. */
async function loadOrgModelHead(orgId: string, modelDbId: string): Promise<DbOrgModelHead | null> {
  // `22P02` = invalid_text_representation (the uuid cast failure), normalised below.
  try {
    const [row] = await db
      .select({
        id: orgModels.id,
        modelId: orgModels.modelId,
        providerId: orgModels.providerId,
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
    return row ?? null;
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return null;
    throw err;
  }
}

/** One custom model as `payerUserId` is served it: its personal credential first, then its org binding (or none). */
async function resolveDbModel(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null,
  excludeSubscriptions: boolean,
): Promise<ResolvedModel | null> {
  const row = await loadOrgModelHead(orgId, modelDbId);
  if (!row || !row.enabled) return null;
  // A stored binding naming a provider this instance does not register must
  // not resolve to null: every caller reads null as "fall through to the org or
  // system default", which would silently run on — and bill — another model.
  const def = getModelProvider(row.providerId);
  if (!def) {
    throw conflict(
      "model_provider_unregistered",
      `Model '${modelDbId}' is bound to a credential of provider '${row.providerId}', which this ` +
        `instance does not register. Load that provider's module again (MODULES), or have an ` +
        `operator remove the model and its credential.`,
    );
  }

  const personal = await resolvePersonalModel(orgId, row, payerUserId, excludeSubscriptions);
  if (personal) return personal;

  const { credentialId } = row;
  if (credentialId === null) {
    return buildResolvedModel(row, {
      providerId: row.providerId,
      apiShape: def.apiShape,
      baseUrl: def.defaultBaseUrl,
      apiKey: "",
    });
  }
  const creds = await loadInferenceCredentials(orgId, credentialId);
  return creds ? buildResolvedModel(row, { ...creds, credentialId }) : null;
}

/**
 * Disambiguate the `loadModel(...) === null` result for an org (DB) model: is it
 * null because the model is missing/disabled, or because its stored credential
 * can no longer serve inference — a credential flagged `needsReconnection` (a
 * revoked OAuth grant, or a BYOK API key rejected upstream too often), or
 * (either auth mode) a blob that no longer decrypts?
 *
 * Returns `true` only for that second case, so a caller can surface an
 * actionable "reconnect" instead of a misleading "not found / not enabled".
 *
 * Scope, precisely — `true` requires ALL of: an existing DB row (system models
 * and non-UUID ids answer `false`), that is `enabled`, whose credential fails
 * {@link loadInferenceCredentials} AND still resolves through
 * {@link loadCredentialMetadata}. That last conjunct is what keeps this aligned
 * with what {@link listOrgModels} actually RENDERS as dead: a row whose
 * credential row is gone, or whose `providerId` has no registry entry (its
 * provider module was dropped from `MODULES`), is not listed at all — and its
 * credential is fine, so "reconnect it" would be advice that fixes nothing
 * about a row the client cannot even see (`loadModel` refuses the latter with
 * 409 `model_provider_unregistered`). The fix there is to restore the
 * provider.
 *
 * One divergence from the list is deliberate: a DISABLED row on a dead
 * credential is flagged by the list (which flags regardless of `enabled`) but
 * answers `false` here. It is inert either way — `resolveModel` cascades past
 * it — and the actionable advice for it is "enable it", not "reconnect".
 *
 * An unbound row is served by the payer's own credentials, so with a payer the
 * question is asked of each of theirs that applies to it.
 */
export async function modelNeedsReconnection(
  orgId: string,
  modelDbId: string,
  payerUserId: string | null = null,
): Promise<boolean> {
  const row = await loadModelBinding(orgId, modelDbId);
  if (!row || !row.enabled) return false;
  if (row.credentialId !== null) return credentialIsDeadButListed(orgId, row.credentialId);
  for (const credentialId of await payerCredentialIds(orgId, payerUserId, row)) {
    if (await credentialIsDeadButListed(orgId, credentialId)) return true;
  }
  return false;
}

/** A custom row's credential and switch — undefined for a system id, an unknown row or a non-UUID. */
async function loadModelBinding(
  orgId: string,
  modelDbId: string,
): Promise<
  | {
      credentialId: string | null;
      enabled: boolean;
      aliased: boolean;
      providerId: string;
      modelId: string;
    }
  | undefined
> {
  if (isSystemModel(modelDbId)) return undefined;
  try {
    const [row] = await db
      .select({
        credentialId: orgModels.credentialId,
        enabled: orgModels.enabled,
        aliased: orgModels.aliased,
        providerId: orgModels.providerId,
        modelId: orgModels.modelId,
      })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
      .limit(1);
    return row;
  } catch (err) {
    // Same non-UUID cast hazard `loadModel` guards against → treat as "no".
    if (isInvalidTextRepresentation(err)) return undefined;
    throw err;
  }
}

/** Dead for inference but still renderable — see {@link modelNeedsReconnection}. */
async function credentialIsDeadButListed(orgId: string, credentialId: string): Promise<boolean> {
  if ((await loadInferenceCredentials(orgId, credentialId)) !== null) return false;
  return (await loadCredentialMetadata(credentialId, orgId)) !== null;
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
  payerUserId: string | null,
): Promise<ResolvedModel | null> {
  if (!modelId) return null;
  // Resolved for the payer: a model their own credential serves exists for them
  // even when its organization credential is dead.
  const model = await loadModel(orgId, modelId, payerUserId);
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
 * `PATCH /spaces/{spaceId}/packages/{scope}/{name}` and the two schedule
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
 * so the 400 on `PATCH /agents/{scope}/{name}/model`, `PATCH /spaces/{spaceId}/
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
  requireBoundModel(model);

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
