// SPDX-License-Identifier: Apache-2.0

/** The link an invitee opens. Call it on click: the origin is a browser fact. */
export function invitationUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}
