// SPDX-License-Identifier: Apache-2.0

// The library focuses the editor at run start; undo it unless the user was in it or it autofocuses.
export function shouldBlurAfterRunStart(state: {
  autofocus: boolean;
  focusedAtSend: boolean;
  focusedNow: boolean;
}): boolean {
  return !state.autofocus && state.focusedNow && !state.focusedAtSend;
}
