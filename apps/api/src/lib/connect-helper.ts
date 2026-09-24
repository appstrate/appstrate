// SPDX-License-Identifier: Apache-2.0

/**
 * The `@appstrate/connect-helper` range this platform speaks, as `npx` resolves
 * it. Each `0.x` minor of the helper is a wire contract with the platform (the
 * pair/redeem body and response): bump this with the platform release that
 * changes that wire, and publish the helper minor alongside it. Never `@latest`
 * — that hands every deployed platform whichever helper was published last.
 *
 * `0.3.x` is the `^0.3` range spelled without `^` / `~`, which cmd.exe and
 * zsh's EXTENDED_GLOB would otherwise read as an escape or a glob operator.
 */
export const CONNECT_HELPER_PACKAGE = "@appstrate/connect-helper@0.3.x";

/** The ready-to-paste command the dashboard shows for a pairing token. */
export function connectHelperCommand(token: string): string {
  return `npx ${CONNECT_HELPER_PACKAGE} ${token}`;
}
