// SPDX-License-Identifier: Apache-2.0

import { useState, type SetStateAction } from "react";

import { stableJson } from "../lib/stable-json";

/** A local edit survives refetches; a clean form follows the latest stored value. */
export function useSettingDraft<T>(stored: T) {
  const source = stableJson(stored);
  const [state, setState] = useState({ source, baseline: stored, value: stored });
  const dirty = stableJson(state.value) !== stableJson(state.baseline);
  if (source !== state.source) {
    setState({
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
    reset: () => setState({ source, baseline: stored, value: stored }),
    accept: (sent: T, accepted: T = sent) =>
      setState((previous) => ({
        ...previous,
        baseline: accepted,
        value: stableJson(previous.value) === stableJson(sent) ? accepted : previous.value,
      })),
  };
}
