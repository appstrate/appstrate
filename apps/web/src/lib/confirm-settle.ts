// SPDX-License-Identifier: Apache-2.0

import type { Mutation, MutationCache } from "@tanstack/react-query";

/**
 * One confirmation at a time: runs `confirm` unless an earlier one has not
 * settled, `onRefused` when a mutation it started failed. Read off the cache,
 * synchronously — `isPending` is render state and lags a click or a refusal.
 */
export function createConfirmer(cache: MutationCache) {
  let confirming = false;
  return (confirm: () => void, onRefused: () => void): void => {
    if (confirming) return;
    confirming = true;
    const started: Mutation<unknown, unknown, unknown, unknown>[] = [];
    const stopCollecting = cache.subscribe((event) => {
      if (event.type === "added") started.push(event.mutation);
    });
    try {
      confirm();
    } finally {
      stopCollecting();
    }

    const settle = (): boolean => {
      const statuses = started.map((mutation) => mutation.state.status);
      if (statuses.some((status) => status === "idle" || status === "pending")) return false;
      confirming = false;
      if (statuses.includes("error")) onRefused();
      return true;
    };
    if (settle()) return;
    const stopWatching = cache.subscribe((event) => {
      if (event.type === "updated" && started.includes(event.mutation) && settle()) stopWatching();
    });
  };
}
