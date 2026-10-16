// SPDX-License-Identifier: Apache-2.0

import { useState, type SetStateAction } from "react";
import { useStore } from "zustand";
import { orgStore } from "../stores/org-store";
import { spaceStore } from "../stores/space-store";

/** Key-order independent, so re-adding a key does not make an unchanged value dirty. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

/**
 * A local edit survives refetches; a clean form follows the latest stored value.
 * A change of organization or space drops the edit: it was made against the previous
 * scope's values, and the navigation guard has already asked before the switch.
 */
export function useSettingDraft<T>(stored: T) {
  const scope = `${useStore(orgStore, (s) => s.id)}:${useStore(spaceStore, (s) => s.id)}`;
  const source = stableJson(stored);
  const [state, setState] = useState({ scope, source, baseline: stored, value: stored });
  const dirty = stableJson(state.value) !== stableJson(state.baseline);
  if (scope !== state.scope) {
    setState({ scope, source, baseline: stored, value: stored });
  } else if (source !== state.source) {
    setState({
      scope,
      source,
      baseline: dirty ? state.baseline : stored,
      value: dirty ? state.value : stored,
    });
  }
  return {
    value: state.value,
    baseline: state.baseline,
    dirty,
    set: (next: SetStateAction<T>) =>
      setState((previous) => ({
        ...previous,
        value: typeof next === "function" ? (next as (value: T) => T)(previous.value) : next,
      })),
    reset: () => setState({ scope, source, baseline: stored, value: stored }),
    accept: (sent: T, accepted: T = sent) =>
      setState((previous) => ({
        ...previous,
        baseline: accepted,
        value: stableJson(previous.value) === stableJson(sent) ? accepted : previous.value,
      })),
  };
}
