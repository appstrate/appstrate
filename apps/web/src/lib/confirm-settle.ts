// SPDX-License-Identifier: Apache-2.0

import type { Mutation, MutationCache } from "@tanstack/react-query";

/**
 * Run a dialog's confirm action and report when what it started has settled.
 *
 * The mutations are read off the mutation cache, whose events are synchronous,
 * rather than off the caller's `isPending`: that one is render state, and
 * React Query flushes it on a timer. Two clicks in one frame both saw it false,
 * and in a background tab (timers throttled) the pending and the failed states
 * arrive in ONE render, so a dialog watching for "was pending, no longer is"
 * never saw the refusal it was meant to close on.
 *
 * `onSettled(refused)` is called once: synchronously when `confirm` started no
 * mutation, otherwise when every mutation it started has finished — `refused`
 * when one of them failed.
 */
export function trackConfirm(
  cache: MutationCache,
  confirm: () => void,
  onSettled: (refused: boolean) => void,
): void {
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
    onSettled(statuses.includes("error"));
    return true;
  };
  if (settle()) return;
  const stopWatching = cache.subscribe((event) => {
    if (event.type === "updated" && started.includes(event.mutation) && settle()) stopWatching();
  });
}
