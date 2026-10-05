// SPDX-License-Identifier: Apache-2.0

/**
 * The confirmed action has settled — `isPending` fell after a confirm click —
 * on a dialog that is still open, which is the refused case: a success closes
 * it from the caller's `onSuccess` first.
 */
export function settledWhileOpen(state: {
  confirmed: boolean;
  wasPending: boolean;
  isPending: boolean;
  open: boolean;
}): boolean {
  return state.confirmed && state.wasPending && !state.isPending && state.open;
}
