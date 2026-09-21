// SPDX-License-Identifier: Apache-2.0

/**
 * Agent authoring — the composer's switch for whether the assistant may create
 * agents (persistent, or composed on the fly for a one-off task).
 *
 * A PREFERENCE, not a permission. The permissions are `agents:write` (and
 * `agents:run` to execute an on-the-fly agent), checked server-side; this only
 * says whether the caller wants the assistant to use them on a given turn.
 * Off, the server drops `agents:write` from the turn's token.
 *
 * Global (all conversations) and persisted, like the model default: it tracks
 * how the user wants the assistant to behave, not what one thread is about.
 * On unless the stored value says `"off"`.
 */

const KEY = "appstrate.chat.agentAuthoring";

function readAgentAuthoring(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let cache = readAgentAuthoring();
const listeners = new Set<() => void>();

export function subscribeAgentAuthoring(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentAuthoringEnabled(): boolean {
  return cache;
}

export function setAgentAuthoringEnabled(enabled: boolean): void {
  if (cache === enabled) return;
  cache = enabled;
  try {
    if (enabled) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // ignore quota / unavailable storage — the choice just won't persist.
  }
  for (const listener of listeners) listener();
}
