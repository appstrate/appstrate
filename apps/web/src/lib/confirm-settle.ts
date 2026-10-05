// SPDX-License-Identifier: Apache-2.0

/**
 * What a confirm dialog remembers between renders, kept outside React state on
 * purpose: `isPending` only reaches the button after a re-render, so two clicks
 * in the same frame would both go through if the record were render state.
 */
export interface ConfirmRecord {
  /** A confirm click was accepted and its action has not settled yet. */
  confirmed: boolean;
  /** `isPending` as of the last commit. */
  wasPending: boolean;
}

export const IDLE_CONFIRM: ConfirmRecord = { confirmed: false, wasPending: false };

/**
 * A click on the confirm button. Dropped while an earlier one is still
 * outstanding: the second request would answer a 404 on what the first just
 * deleted, and toast an error over a success.
 */
export function confirmClick(record: ConfirmRecord): { accepted: boolean; record: ConfirmRecord } {
  if (record.confirmed) return { accepted: false, record };
  return { accepted: true, record: { ...record, confirmed: true } };
}

/**
 * A commit of the dialog. `settled` is the confirmed action having finished —
 * `isPending` fell after a confirm click — on a dialog that is still open,
 * which is the refused case: a success closes it from the caller's `onSuccess`
 * first. The click record is cleared when the action settles or the dialog
 * closes, so a dialog kept open after a refusal, or reopened, confirms again.
 */
export function confirmCommit(
  record: ConfirmRecord,
  now: { isPending: boolean; open: boolean },
): { settled: boolean; record: ConfirmRecord } {
  const settled = record.confirmed && record.wasPending && !now.isPending && now.open;
  return {
    settled,
    record: { confirmed: record.confirmed && now.open && !settled, wasPending: now.isPending },
  };
}
