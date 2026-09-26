// SPDX-License-Identifier: Apache-2.0

/**
 * Currently selected chat model (org preset id).
 *
 * Two scopes: the localStorage value is the user's DEFAULT, what a new
 * conversation starts on; `activeModelId` is the OPEN conversation's model,
 * seeded from its newest turn that carries a model and overridden by a pick. The seed is a
 * pre-selection, not a lock — the server honours each turn's `X-Model-Id`.
 * INVARIANT: once the catalog is known, the selection is always a live model,
 * whichever of catalog and seed lands first.
 * Generation settings are ONE global preference, pruned only against the
 * default model; what is shown and sent is reconciled against the selected
 * model without writing back.
 *
 * Exposed as an external store (`useSyncExternalStore`) rather than React
 * state so the transport's per-request header builder can read the CURRENT
 * selection through a stable function: `useChat` recreates its `Chat` instance
 * only when the conversation id changes, so a transport rebuilt over fresh
 * state is silently ignored and every send would keep the model captured at
 * mount.
 */

import {
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";
import { isModelLive } from "../model-liveness.ts";

const KEY = "appstrate.chat.model";
const GENERATION_KEY = "appstrate.chat.generation";

let cache: string | null = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
const listeners = new Set<() => void>();
const generationListeners = new Set<() => void>();
let generationCapabilities = new Map<string, ModelGenerationCapabilities>();
/** Ids of the live catalog models; `null` until the catalog has loaded once. */
let liveModelIds: ReadonlySet<string> | null = null;
let ownCredentialModelAvailable = false;
let generationCache: ModelGenerationSettings = (() => {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = modelGenerationSettingsSchema.safeParse(
      JSON.parse(localStorage.getItem(GENERATION_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
})();

export function subscribeModel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Conversation the composer is currently attached to (`null` = none mounted). */
let activeConversationId: string | null = null;
let activeModelId: string | null = null;

export function getSelectedModel(): string | null {
  return activeModelId ?? cache;
}

/** A seed never overrides a pick made while the history was in flight. */
export function attachConversation(id: string | null, seedModelId: string | null): void {
  let changed = false;
  if (activeConversationId !== id) {
    activeConversationId = id;
    changed = activeModelId !== null;
    activeModelId = null;
  }
  if (
    id !== null &&
    activeModelId === null &&
    seedModelId !== null &&
    (liveModelIds === null || liveModelIds.has(seedModelId))
  ) {
    activeModelId = seedModelId;
    changed = true;
  }
  if (changed) notifyModel();
}

/** A pick sets both the open conversation's model and the stored default. */
export function setSelectedModel(id: string | null): void {
  const reconciled = reconcileModelGenerationSettings(
    generationCache,
    id === null ? undefined : generationCapabilities.get(id),
  );
  if (reconciled !== generationCache) setGenerationSettings(reconciled);

  let changed = false;
  if (activeConversationId !== null && activeModelId !== id) {
    activeModelId = id;
    changed = true;
  }
  if (setDefaultModel(id)) changed = true;
  if (changed) notifyModel();
}

function setDefaultModel(id: string | null): boolean {
  if (cache === id) return false;
  cache = id;
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // ignore quota / unavailable storage — the selection just won't persist.
  }
  return true;
}

/** The compatible generation settings follow the selected model: notify both. */
function notifyModel(): void {
  recomputeCompatible();
  for (const l of listeners) l();
  for (const l of generationListeners) l();
}

/** Runs on every catalog change; a dead model is listed but never kept selected. */
export function setModelCatalog(
  models: ReadonlyArray<{
    id: string;
    is_default?: boolean;
    needs_reconnection?: boolean;
    source?: "built-in" | "custom";
    generation?: ModelGenerationCapabilities | null;
  }>,
): void {
  generationCapabilities = new Map(
    models.flatMap((model) => (model.generation ? [[model.id, model.generation] as const] : [])),
  );
  const live = models.filter(isModelLive);
  liveModelIds = new Set(live.map((m) => m.id));
  ownCredentialModelAvailable = live.some((m) => m.source === "custom");

  if (activeModelId !== null && !liveModelIds.has(activeModelId)) activeModelId = null;
  if (cache === null || !liveModelIds.has(cache)) {
    setDefaultModel((live.find((m) => m.is_default) ?? live[0])?.id ?? null);
  }

  const reconciled = reconcileModelGenerationSettings(generationCache, defaultCapabilities());
  if (reconciled !== generationCache) setGenerationSettings(reconciled);
  notifyModel();
}

/** `useSyncExternalStore` snapshot: a live model runs on the org's own credential. */
export function hasOwnCredentialModel(): boolean {
  return ownCredentialModelAvailable;
}

function defaultCapabilities(): ModelGenerationCapabilities | undefined {
  return cache === null ? undefined : generationCapabilities.get(cache);
}

export function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

/** Cached so `useSyncExternalStore` sees one reference while nothing changed. */
let compatibleCache: ModelGenerationSettings = {};

function recomputeCompatible(): void {
  const modelId = getSelectedModel();
  compatibleCache = reconcileModelGenerationSettings(
    generationCache,
    modelId === null ? undefined : generationCapabilities.get(modelId),
  );
}
recomputeCompatible();

export function getCompatibleGenerationSettings(): ModelGenerationSettings {
  return compatibleCache;
}

/** Keys the selected model hides are kept, so an edit never erases the default's. */
export function editGenerationSettings(value: ModelGenerationSettings): void {
  const shown = getCompatibleGenerationSettings();
  const hidden = Object.fromEntries(
    Object.entries(generationCache).filter(([key]) => !(key in shown)),
  ) as ModelGenerationSettings;
  setGenerationSettings({ ...hidden, ...value });
}

function setGenerationSettings(value: ModelGenerationSettings): void {
  generationCache = value;
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(GENERATION_KEY);
    else localStorage.setItem(GENERATION_KEY, JSON.stringify(value));
  } catch {
    // The settings remain available for this page even if persistence is unavailable.
  }
  recomputeCompatible();
  for (const listener of generationListeners) listener();
}
