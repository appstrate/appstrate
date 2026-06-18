// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";

/**
 * The single seam through which the SPA hands an unauthenticated visitor to
 * the OIDC hosted login / register pages.
 *
 * When the instance runs the OIDC module (`window.__APP_CONFIG__.oidc`
 * present), every auth-entry route funnels through here instead of rendering
 * a native Better Auth form — so a page can never silently bypass the IdP by
 * forgetting its own redirect (the bug class this exists to kill). When OIDC
 * is absent (OSS mode) it is a no-op and the caller renders its built-in form.
 *
 * `<HostedAuthGate>` wraps the simple auth routes (login / register / forgot /
 * reset / magic-link / verify-email) on top of this hook; the invitation page
 * calls the hook directly because its starter (login vs signup) and login-hint
 * depend on invite data loaded asynchronously. Both share this one mechanism.
 */

type HostedAuthStarter = "login" | "signup";

interface HostedAuthRedirectOptions {
  /** Which OIDC hosted flow to start. Defaults to `"login"`. */
  starter?: HostedAuthStarter;
  /** Post-callback destination, persisted across the PKCE round-trip. */
  redirectTo?: string;
  /** OIDC `login_hint` — pins / pre-fills the email on the hosted page. */
  loginHint?: string;
  /**
   * Gate the redirect. Default `true`. Callers pass `false` while async data
   * is still loading or when the visitor is already authenticated, so the
   * redirect fires exactly once with the right parameters.
   */
  enabled?: boolean;
  /** Surface a dynamic-import / redirect failure instead of spinning forever. */
  onError?: (error: unknown) => void;
}

/** Whether this instance runs the OIDC IdP (the hosted login flow). */
export function isHostedAuthEnabled(): boolean {
  return !!(window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
}

/**
 * Returns `{ redirecting }` — `true` while an OIDC redirect is in flight, so
 * callers render a spinner for the brief navigation window instead of flashing
 * the native form. In OSS mode it is always `false`.
 */
export function useHostedAuthRedirect(options: HostedAuthRedirectOptions = {}): {
  redirecting: boolean;
} {
  const { starter = "login", redirectTo, loginHint, enabled = true, onError } = options;
  const active = isHostedAuthEnabled() && enabled;

  useEffect(() => {
    if (!active) return;
    void import("../modules/oidc/lib/oidc")
      .then(({ startOidcLogin, startOidcSignup }) =>
        starter === "signup"
          ? startOidcSignup(redirectTo, loginHint)
          : startOidcLogin(redirectTo, loginHint),
      )
      .catch((err) => onError?.(err));
    // `onError` is intentionally excluded — callers pass an inline closure that
    // would otherwise re-fire the redirect on every render. The redirect inputs
    // (starter / redirectTo / loginHint / active) are the only real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, starter, redirectTo, loginHint]);

  return { redirecting: active };
}
