// SPDX-License-Identifier: Apache-2.0

/**
 * Currently selected chat model (org preset id), persisted in localStorage.
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
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

const KEY = "appstrate.chat.model";
const GENERATION_KEY = "appstrate.chat.generation";

let cache: string | null = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
const listeners = new Set<() => void>();
const generationListeners = new Set<() => void>();
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

export function getSelectedModel(): string | null {
  return cache;
}

export function setSelectedModel(id: string | null): void {
  if (cache === id) return;
  cache = id;
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // ignore quota / unavailable storage — the selection just won't persist.
  }
  for (const l of listeners) l();
}

export function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

export function getGenerationSettings(): ModelGenerationSettings {
  return generationCache;
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
