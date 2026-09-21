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
 * re-seeds from the transcript. Keeping older conversations' models here would
 * be a cache of something already authoritative elsewhere, and an unbounded
 * one.
 *
 * The second scope is the bug fix. With one global value, reopening a
 * conversation answered by model A while the store held B continued it on B
 * silently — nothing pinned it, nothing showed it. The conversation's own
 * transcript is the authority for what it was on; localStorage only answers
 * for a conversation that has no transcript yet.
 *
 * It is NOT persisted: it is derived from history on every load, so the server
 * stays the single source. What a reload drops is an unsent pick, which cost
 * nothing.
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

const KEY = "appstrate.chat.model";
const GENERATION_KEY = "appstrate.chat.generation";

let cache: string | null = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
const listeners = new Set<() => void>();
const generationListeners = new Set<() => void>();
let generationCapabilities = new Map<string, ModelGenerationCapabilities>();
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
 * Seed the open conversation's model from its own transcript.
 *
 * Ignored when the id is not the active conversation (a history load that
 * resolved after the user navigated away), and when a model is already set —
 * an explicit pick made while the history was in flight is the user's, and the
 * transcript is older news.
 */
export function seedConversationModel(conversationId: string, modelId: string): void {
  if (conversationId !== activeConversationId || activeModelId !== null) return;
  activeModelId = modelId;
  notifyModel();
}

/**
 * An explicit pick: it becomes the open conversation's model AND the stored
 * default for the next new chat — a pick is a statement of preference, not
 * only of this thread's binding.
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

  if (cache !== id) {
    cache = id;
    changed = true;
    try {
      if (id === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, id);
    } catch {
      // ignore quota / unavailable storage — the selection just won't persist.
    }
  }

  if (changed) notifyModel();
}

function notifyModel(): void {
  for (const l of listeners) l();
}

export function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

export function getGenerationSettings(): ModelGenerationSettings {
  return generationCache;
}

export function getCompatibleGenerationSettings(): ModelGenerationSettings {
  return reconcileModelGenerationSettings(
    generationCache,
    cache === null ? undefined : generationCapabilities.get(cache),
  );
}

export function setModelGenerationCapabilities(
  models: ReadonlyArray<{
    id: string;
    generation?: ModelGenerationCapabilities | null;
  }>,
): void {
  generationCapabilities = new Map(
    models.flatMap((model) => (model.generation ? [[model.id, model.generation] as const] : [])),
  );
  const reconciled = getCompatibleGenerationSettings();
  if (reconciled !== generationCache) setGenerationSettings(reconciled);
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
