// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical identifiers for the official Appstrate CLI OAuth client.
 *
 * Kept in one place so `commands/login.ts`, `commands/logout.ts`, and
 * `lib/api.ts` can't drift — a silent rename of the client_id here would
 * otherwise require a synchronised edit across three call sites, which is
 * exactly the kind of refactor trap the review called out.
 *
 * `CLI_CLIENT_ID` must match the identifier `ensureCliClient()` seeds
 * server-side (see `apps/api/src/modules/oidc/auth/plugins.ts`). The
 * scope set is the one the server honors for this client —
 * `offline_access` is what unlocks refresh-token issuance.
 */

export const CLI_CLIENT_ID = "appstrate-cli";

export const CLI_SCOPE = "openid profile email offline_access";
