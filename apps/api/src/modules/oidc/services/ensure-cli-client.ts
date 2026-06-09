// SPDX-License-Identifier: Apache-2.0

/**
 * The `appstrate-cli` OAuth client moved into the declarative first-party
 * client registry (`first-party-clients.ts`). This module is kept as a thin
 * re-export so existing call sites and tests continue to import
 * `ensureCliClient` / `APPSTRATE_CLI_CLIENT_ID` from here.
 */

export { ensureCliClient, APPSTRATE_CLI_CLIENT_ID } from "./first-party-clients.ts";
