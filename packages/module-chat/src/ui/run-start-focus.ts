// SPDX-License-Identifier: Apache-2.0

// The library focuses the editor at run start: undo it, unless the editor held the focus at send
// or the device autofocuses the composer, so a phone opens no keyboard on a field the user left.
export function shouldBlurAfterRunStart(state: {
  autofocus: boolean;
  focusedAtSend: boolean;
  focusedNow: boolean;
}): boolean {
  return !state.autofocus && state.focusedNow && !state.focusedAtSend;
}
