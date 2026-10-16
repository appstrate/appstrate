// SPDX-License-Identifier: Apache-2.0

import { useState, type SetStateAction } from "react";

/** A local edit survives refetches; a clean form follows the latest stored value. */
export function useSettingDraft<T>(stored: T) {
  const source = JSON.stringify(stored);
  const [state, setState] = useState({ source, baseline: stored, value: stored });
  const dirty = JSON.stringify(state.value) !== JSON.stringify(state.baseline);
  if (source !== state.source) {
    setState({
      source,
      baseline: dirty ? state.baseline : stored,
      value: dirty ? state.value : stored,
    });
  }
  return {
    value: state.value,
    dirty,
    set: (next: SetStateAction<T>) =>
      setState((previous) => ({
        ...previous,
        value: typeof next === "function" ? (next as (value: T) => T)(previous.value) : next,
      })),
    reset: () => setState({ source, baseline: stored, value: stored }),
    accept: (value: T) => setState((previous) => ({ ...previous, baseline: value, value })),
  };
}
