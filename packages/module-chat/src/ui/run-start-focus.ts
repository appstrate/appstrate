// SPDX-License-Identifier: Apache-2.0

/**
 * The library's editor takes the focus when a run starts, with no switch to turn that off. A phone
 * would then open its keyboard on a field the user had left: after the library's own listener, the
 * editor is blurred again when it was not the focused element as the message was sent.
 */
export function shouldBlurAfterRunStart(state: {
  /** The device auto-focuses the composer (a wide screen with a hovering pointer). */
  autofocus: boolean;
  /** The editor held the focus when the message was sent. */
  focusedAtSend: boolean;
  /** The editor holds the focus now, after the library's run-start focus. */
  focusedNow: boolean;
}): boolean {
  return !state.autofocus && state.focusedNow && !state.focusedAtSend;
}
