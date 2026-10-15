// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { rememberSignedIn } from "../lib/session-read";

/**
 * The single seam handing an unauthenticated visitor to the OIDC hosted login / register pages,
 * so no auth-entry route can bypass the IdP by forgetting its own redirect. A no-op when the OIDC
 * module is absent (the caller renders its built-in form). The invitation page calls the hook
 * directly because its starter and login-hint depend on asynchronously loaded invite data.
 */

type HostedAuthStarter = "login" | "signup";

interface HostedAuthRedirectOptions {
  starter?: HostedAuthStarter;
  /** Post-callback destination, persisted across the PKCE round-trip. */
  redirectTo?: string;
  loginHint?: string;
  /** Gate the redirect (default `true`): `false` while async data loads or once authenticated, so it fires once with the right parameters. */
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

export function isHostedAuthEnabled(): boolean {
  return !!(window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
}

/** `{ redirecting }` is `true` while an OIDC redirect is in flight (render a spinner, not the native form); always `false` in OSS mode. */
export function useHostedAuthRedirect(options: HostedAuthRedirectOptions = {}): {
  redirecting: boolean;
} {
  const { starter = "login", redirectTo, loginHint, enabled = true, onError } = options;
  const active = isHostedAuthEnabled() && enabled;

  useEffect(() => {
    if (!active) return;
    void import("../modules/oidc/lib/oidc")
      .then(({ startOidcLogin, startOidcSignup }) => {
        rememberSignedIn(localStorage, true);
        return starter === "signup"
          ? startOidcSignup(redirectTo, loginHint)
          : startOidcLogin(redirectTo, loginHint);
      })
      .catch((err) => onError?.(err));
    // `onError` is excluded: an inline closure would re-fire the redirect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, starter, redirectTo, loginHint]);

  return { redirecting: active };
}
