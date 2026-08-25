// SPDX-License-Identifier: Apache-2.0

/**
 * The password length bounds — the single source of truth for what Better Auth
 * enforces.
 *
 * **This module MUST stay import-free**, for the same reason `run-status.ts`
 * must: it is reached from the browser bundle (`@appstrate/shared-types`
 * re-exports the values to the SPA), and any import added here would drag the
 * rest of the DB package — better-auth, drizzle, `@appstrate/env` — into the
 * SPA's eager entry graph.
 *
 * These live beside the enforcer rather than in a neutral package because the
 * enforcer is what makes them true: `emailAndPassword.minPasswordLength` and
 * `maxPasswordLength` in `auth.ts` are the rules every other declaration merely
 * *reports*.
 *
 * ## The rule, stated instead of enumerated
 *
 * Any surface that states a password bound imports these constants and
 * interpolates them: an HTML `minlength`, a Zod `.min()` / `.max()`, an OpenAPI
 * `minLength` / `maxLength`, a hand-written validator branch, and the
 * user-facing sentence that reports the number to a human.
 *
 * There is deliberately NO list of those surfaces here. The previous version of
 * this docstring carried one, called it closed ("everything else imports the
 * constant"), and was wrong about eight sites — including the two OIDC pages
 * whose `minlength=` attribute read the constant while the handler behind that
 * same form compared against a literal `8`. Bump the constant and the page said
 * one number while the enforcer accepted another: exactly the split the constant
 * exists to prevent. A list rots silently and reports success while doing so;
 * the rule does not. `grep -rn 'MIN_PASSWORD_LENGTH\|MAX_PASSWORD_LENGTH'` is
 * the current list, and a bare `8` or `128` beside the word "password" is a bug.
 *
 * ## Why the maximum is shared too
 *
 * It was not, and the same defect class was open on it: `profile` capped at 128,
 * `auth-bootstrap` at 256, `sign-up/email` declared no ceiling at all, and
 * `auth.ts` set no `maxPasswordLength`, so Better Auth's own default (128)
 * governed. A 200-character password passed `auth-bootstrap`'s Zod and was then
 * rejected by Better Auth as a raw `APIError` instead of an RFC 9457 problem.
 * Two endpoints that set the SAME credential cannot disagree about its length —
 * that is a rule about the credential, not a per-endpoint transport bound.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Equal to Better Auth's own default ceiling. `auth.ts` now sets
 * `maxPasswordLength` from this constant explicitly, so the framework default
 * can never move underneath the declarations that report it.
 */
export const MAX_PASSWORD_LENGTH = 128;
