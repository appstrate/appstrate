// SPDX-License-Identifier: Apache-2.0

/**
 * Currently selected chat model (org preset id).
 *
 * TWO scopes, deliberately:
 *
 *  - the localStorage value is the user's DEFAULT — what a NEW conversation
 *    starts on, and what a pick updates;
 *  - `activeModelId` is the model the OPEN conversation is on. It is seeded
 *    from that conversation's own history (the newest assistant turn carrying
 *    `modelId`) and overridden by an explicit pick.
 *
 * ONE slot, not a map: the conversation component is keyed by id and its
 * history query is `gcTime: 0`, so reopening a conversation refetches and
 * re-seeds from the transcript.
 *
 * The seed is a PRE-SELECTION, not a lock. The server honours whatever
 * `X-Model-Id` each turn carries, and switching models mid-conversation is
 * supported on purpose (the history projection is built to replay across a
 * switch). What the seed fixes is the silent case: reopening a conversation
 * answered by model A while the store held B continued it on B without the
 * user ever choosing to. It is not persisted — a reload re-derives it from the
 * transcript, and what it drops is an unsent pick.
 *
 * INVARIANT: once the catalog is known, the selection is always a live model
 * (listed, enabled, credential usable). A seed naming anything else is
 * refused, and a catalog that arrives after the seed prunes it — so the order
 * of the two loads does not matter.
 *
 * Generation settings are ONE global preference. The store only prunes the
 * stored value against the DEFAULT model (on a pick, or when the catalog
 * changes); what is shown and sent is reconciled against the model actually
 * selected, at read time, so opening an old conversation on a model without
 * reasoning never erases the reasoning level the default uses.
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
/** That conversation's model: seeded from its history, or set by a pick. */
let activeModelId: string | null = null;

/** The model this conversation is on, or the stored default for a new one. */
export function getSelectedModel(): string | null {
  return activeModelId ?? cache;
}

/**
 * Attach the store to a conversation, clearing the previous one's model.
 *
 * Called on every conversation mount. The clear is the fix: without it, opening
 * a fresh chat after one answered by model A would inherit A instead of
 * starting on the user's stored default.
 */
export function setActiveConversation(id: string | null): void {
  if (activeConversationId === id) return;
  activeConversationId = id;
  activeModelId = null;
  notifyModel();
}

/**
 * Pre-select the open conversation's model from its own transcript.
 *
 * Ignored when the id is not the active conversation (a history load that
 * resolved after the user navigated away), when a model is already set (an
 * explicit pick made while the history was in flight is the user's, and the
 * transcript is older news), and when the catalog is known and does not serve
 * that model live — a deleted, disabled or disconnected model falls back to
 * the stored default instead of leaving the composer on a model every send
 * would be refused for. A seed that lands before the catalog is checked when
 * the catalog arrives (see {@link setModelCatalog}).
 */
export function seedConversationModel(conversationId: string, modelId: string): void {
  if (conversationId !== activeConversationId || activeModelId !== null) return;
  if (liveModelIds !== null && !liveModelIds.has(modelId)) return;
  activeModelId = modelId;
  notifyModel();
}

/**
 * An explicit pick: it becomes the open conversation's model AND the stored
 * default for the next new chat — a pick is a statement of preference, not
 * only of this thread's binding. The stored generation settings follow it,
 * since they are kept compatible with the default.
 */
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

/**
 * The generation settings depend on the selected model (see
 * {@link getCompatibleGenerationSettings}), so a model change notifies both.
 */
function notifyModel(): void {
  for (const l of listeners) l();
  for (const l of generationListeners) l();
}

/**
 * Load the org's chat catalog (`/api/models`, already narrowed to enabled,
 * chat-usable rows). Runs on every catalog change, not just the first.
 *
 * Restores the invariant that the selection is a live model: a conversation
 * model the catalog no longer serves live is dropped (the conversation falls
 * back to the default), and a stored default that is not live is replaced by
 * the org default, else the first live model. A dead model is listed — the
 * picker marks it — but is never kept selected nor adopted as the fallback.
 */
export function setModelCatalog(
  models: ReadonlyArray<{
    id: string;
    is_default?: boolean;
    needs_reconnection?: boolean;
    generation?: ModelGenerationCapabilities | null;
  }>,
): void {
  generationCapabilities = new Map(
    models.flatMap((model) => (model.generation ? [[model.id, model.generation] as const] : [])),
  );
  const live = models.filter(isModelLive);
  liveModelIds = new Set(live.map((m) => m.id));

  if (activeModelId !== null && !liveModelIds.has(activeModelId)) activeModelId = null;
  if (cache === null || !liveModelIds.has(cache)) {
    setDefaultModel((live.find((m) => m.is_default) ?? live[0])?.id ?? null);
  }

  const reconciled = reconcileModelGenerationSettings(generationCache, defaultCapabilities());
  if (reconciled !== generationCache) setGenerationSettings(reconciled);
  notifyModel();
}

function defaultCapabilities(): ModelGenerationCapabilities | undefined {
  return cache === null ? undefined : generationCapabilities.get(cache);
}

export function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

/** The stored preference, as the user last set it. */
export function getGenerationSettings(): ModelGenerationSettings {
  return generationCache;
}

let compatibleMemo: {
  settings: ModelGenerationSettings;
  modelId: string | null;
  capabilities: ReadonlyMap<string, ModelGenerationCapabilities>;
  result: ModelGenerationSettings;
} | null = null;

/**
 * The stored preference reconciled against the model that is SELECTED — the
 * one `X-Model-Id` carries — which may differ from the default the storage is
 * reconciled against. This is what a request sends and what the picker's
 * configuration tab shows; nothing is written back.
 *
 * Memoized on its inputs so it is a valid `useSyncExternalStore` snapshot
 * (same reference while nothing changed).
 */
export function getCompatibleGenerationSettings(): ModelGenerationSettings {
  const modelId = getSelectedModel();
  if (
    compatibleMemo?.settings === generationCache &&
    compatibleMemo.modelId === modelId &&
    compatibleMemo.capabilities === generationCapabilities
  ) {
    return compatibleMemo.result;
  }
  const result = reconcileModelGenerationSettings(
    generationCache,
    modelId === null ? undefined : generationCapabilities.get(modelId),
  );
  compatibleMemo = {
    settings: generationCache,
    modelId,
    capabilities: generationCapabilities,
    result,
  };
  return result;
}

export function setGenerationSettings(value: ModelGenerationSettings): void {
  generationCache = value;
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(GENERATION_KEY);
    else localStorage.setItem(GENERATION_KEY, JSON.stringify(value));
  } catch {
    // The settings remain available for this page even if persistence is unavailable.
  }
  for (const listener of generationListeners) listener();
}
