// SPDX-License-Identifier: Apache-2.0

// Platform-level auth policy helpers, driven by `AUTH_*` env vars from
// `@appstrate/env`. Pure functions — easy to unit test with constructed
// inputs, no DB access here. The signup gate (auth.ts) and the org
// creation route are the only consumers.
//
// Spec: examples/self-hosting/AUTH_MODES.md.

import { getEnv } from "@appstrate/env";

/** Lowercase + trim. Centralized so every comparison normalizes the same way. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Extract the lowercase domain from an email, or `null` if malformed. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * True when `email` is listed in `AUTH_PLATFORM_ADMIN_EMAILS`. Platform
 * admins bypass the signup gate and may create orgs even when
 * `AUTH_DISABLE_ORG_CREATION=true`. Returns false when the env var is empty.
 */
export function isPlatformAdmin(email: string): boolean {
  const env = getEnv();
  if (env.AUTH_PLATFORM_ADMIN_EMAILS.length === 0) return false;
  return env.AUTH_PLATFORM_ADMIN_EMAILS.includes(normalizeEmail(email));
}

/**
 * True when the email's domain is allowed by `AUTH_ALLOWED_SIGNUP_DOMAINS`.
 * Returns true when the env var is empty (no restriction). False if the
 * email has no recognizable domain.
 */
export function isAllowedSignupDomain(email: string): boolean {
  const env = getEnv();
  if (env.AUTH_ALLOWED_SIGNUP_DOMAINS.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  return env.AUTH_ALLOWED_SIGNUP_DOMAINS.includes(domain);
}

/**
 * True when `email` matches `AUTH_BOOTSTRAP_OWNER_EMAIL`. Used by:
 *   - the signup gate to let the bootstrap account through even with
 *     `AUTH_DISABLE_SIGNUP=true`;
 *   - the after-hook to auto-create the bootstrap organization.
 * Returns false when the env var is empty.
 */
export function isBootstrapOwner(email: string): boolean {
  const env = getEnv();
  if (!env.AUTH_BOOTSTRAP_OWNER_EMAIL) return false;
  return env.AUTH_BOOTSTRAP_OWNER_EMAIL === normalizeEmail(email);
}

/** Reasons surfaced by `evaluateSignupPolicy`. Stable identifiers — used in error messages and tests. */
export type SignupBlockReason = "signup_disabled" | "signup_domain_not_allowed";

export type SignupPolicyDecision =
  | { allowed: true; reason: "open" | "platform_admin" | "bootstrap" | "invitation" | "domain_ok" }
  | { allowed: false; reason: SignupBlockReason };

/**
 * Pure decision function — given the env policy and whether a pending
 * invitation exists, decide whether `email` may sign up. The DB lookup for
 * the invitation is the caller's responsibility; this function only does
 * the policy combination.
 *
 * Order matters and is documented in docs/self-hosting/auth-modes.md.
 */
export function evaluateSignupPolicy(
  email: string,
  hasPendingInvitation: boolean,
): SignupPolicyDecision {
  const env = getEnv();

  // 1. Signup not locked down → enforce only the domain allowlist.
  if (!env.AUTH_DISABLE_SIGNUP) {
    if (!isAllowedSignupDomain(email)) {
      return { allowed: false, reason: "signup_domain_not_allowed" };
    }
    return { allowed: true, reason: "domain_ok" };
  }

  // 2. Signup locked down — allow the 3 exceptions, in priority order.
  if (isBootstrapOwner(email)) return { allowed: true, reason: "bootstrap" };
  if (isPlatformAdmin(email)) return { allowed: true, reason: "platform_admin" };
  if (hasPendingInvitation) return { allowed: true, reason: "invitation" };

  // 3. Locked down + no exception → reject. Domain allowlist still applies
  // before the closed-mode rejection so the caller sees the most specific
  // reason when both fail.
  if (!isAllowedSignupDomain(email)) {
    return { allowed: false, reason: "signup_domain_not_allowed" };
  }
  return { allowed: false, reason: "signup_disabled" };
}
