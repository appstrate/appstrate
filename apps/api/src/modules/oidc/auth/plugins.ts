// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugins contributed by the OIDC module.
 *
 * Stage 3 scope: the plugin list is intentionally empty. The auth strategy
 * (`./strategy.ts`) is wired independently and verifies Bearer JWTs against
 * whatever JWKS is served at `APP_URL/api/auth/jwks` — which lets Stage 3
 * ship a fully-tested verification pipeline without committing to a specific
 * Better Auth plugin package.
 *
 * Stage 5 (login + consent pages + actual token issuance) will wire:
 *   - `jwt({ jwks: { keyPairConfig: { alg: "ES256" }, rotationInterval: ... } })`
 *     — populates the JWKS table + exposes `/api/auth/jwks`
 *   - an oauth-provider plugin (exact package TBD — PR #66 used the
 *     separate `@better-auth/oauth-provider` which is NOT currently in the
 *     lockfile; Better Auth also ships a built-in `oidcProvider` plugin
 *     whose schema shape is materially different from ours). Stage 5 will
 *     reconcile this before committing: pick one, align `schema.ts` + the
 *     0000 migration if needed, then add the plugin here with the
 *     `customAccessTokenClaims` closure that injects `endUserId` +
 *     `applicationId` from `resolveOrCreateEndUser()`.
 *
 * Stage 3 therefore ships this file as a scaffold so that `index.ts` can
 * call `oidcBetterAuthPlugins()` unconditionally — when Stage 5 lands it
 * only edits this single file.
 */

/**
 * Return the Better Auth plugin list contributed by this module.
 *
 * Typed as `unknown[]` to match the `AppstrateModule.betterAuthPlugins()`
 * contract — `@appstrate/core` deliberately keeps Better Auth types out of
 * its published API so the module contract stays framework-agnostic.
 */
export function oidcBetterAuthPlugins(): unknown[] {
  return [];
}
