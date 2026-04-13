// SPDX-License-Identifier: Apache-2.0

/**
 * Shared auth-layer types for the OIDC module. Kept here (not in a
 * service) so both `services/enduser-mapping.ts` and
 * `services/orgmember-mapping.ts` can consume the same shape without
 * creating a service→service import.
 */

/**
 * Subset of a Better Auth `user` row that the OIDC mapping services need.
 * Constructed by `plugins.ts` from the BA session and passed through to
 * `resolveOrCreateEndUser()` / `resolveOrCreateOrgMembership()`.
 */
export interface AuthIdentity {
  /** Better Auth `user.id`. */
  id: string;
  /** Better Auth `user.email` — lowercased + trimmed before use. */
  email: string;
  /** Display name, if provided by BA. Informational only. */
  name?: string | null;
  /** `true` only when Better Auth explicitly verified the email (strict). */
  emailVerified?: boolean;
}
