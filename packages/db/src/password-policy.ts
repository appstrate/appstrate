// SPDX-License-Identifier: Apache-2.0

/**
 * The minimum password length — the single source of truth for the value
 * Better Auth enforces.
 *
 * **This module MUST stay import-free**, for the same reason `run-status.ts`
 * must: it is reached from the browser bundle (`@appstrate/shared-types`
 * re-exports the value to the SPA), and any import added here would drag the
 * rest of the DB package — better-auth, drizzle, `@appstrate/env` — into the
 * SPA's eager entry graph.
 *
 * It lives beside the enforcer rather than in a neutral package because the
 * enforcer is what makes it true: `emailAndPassword.minPasswordLength` in
 * `auth.ts` is the rule every other declaration merely *reports*. Those
 * reporters are the login and register forms (SPA), the account-password forms
 * (SPA), the two OpenAPI request schemas, the `profile` / `auth-bootstrap` Zod
 * bounds, and the server-rendered OIDC signup + reset-password pages. Before
 * this constant existed the SPA's two auth forms said 6 while everything else
 * said 8 — so the form told the user a 6-character password was acceptable,
 * accepted it, submitted it, and Better Auth rejected it.
 *
 * Only the MINIMUM is shared. Maximum lengths stay per-endpoint (`profile`
 * caps at 128, `auth-bootstrap` at 256): those are transport bounds, not this
 * rule.
 */
export const MIN_PASSWORD_LENGTH = 8;
