// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { authClient } from "../lib/auth-client";
import { client } from "../api/client";
import { authStore, type AuthProfile } from "../stores/auth-store";
import { toAuthError, toLoginError, toUnlinkError } from "../lib/auth-errors";
import { EMAIL_CHANGE_CALLBACK_URL, emailWasChanged } from "../lib/auth-flow";
import { clearSession } from "../lib/clear-session";
import { readSession, rememberSignedIn, sessionExpected } from "../lib/session-read";
import { registerSessionCheck } from "../lib/stale-authority";
import i18n from "../i18n";

async function fetchProfile(): Promise<AuthProfile | null> {
  try {
    const { data } = await client.GET("/api/profile");
    if (!data) return null;
    const profile: AuthProfile = {
      id: data.id,
      displayName: data.displayName ?? null,
      language: data.language,
      canCreateOrg: data.can_create_org,
    };
    if (profile.language && profile.language !== i18n.language) {
      i18n.changeLanguage(profile.language);
    }
    return profile;
  } catch {
    return null;
  }
}

function setAuthenticatedUser(
  user: { id: string; email: string; emailVerified: boolean; name: string },
  profile: AuthProfile | null,
) {
  rememberSignedIn(localStorage, true);
  authStore.setState({
    user: { id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name },
    profile,
    loading: false,
  });
}

async function syncAuth(expected: boolean) {
  const session = await readSession(expected, {
    getSession: async () => (await authClient.getSession()).data?.user ?? null,
    getProfile: fetchProfile,
    // Best-effort: `clearSession` resets the SPA stores either way.
    dropCookies: async () => {
      await authClient.signOut().catch(() => {});
    },
  });
  if (session) setAuthenticatedUser(session.user, session.profile);
  else clearSession();
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;
  syncAuth(sessionExpected(localStorage)).catch(() => {
    clearSession();
  });
}

// Only Better Auth's own "no user" signs out: unlike at boot, a profile that
// failed to load proves nothing here.
registerSessionCheck({
  hasSession: async () => {
    const result = await authClient.getSession();
    return result.error ? null : !!result.data?.user;
  },
  endSession: async () => {
    await authClient.signOut().catch(() => {});
    clearSession();
  },
});

/**
 * Start the session resync at boot rather than on the first `useAuth()`
 * render. Called from `main.tsx` before `createRoot`, so the session/profile
 * round-trip overlaps the locale fetch and the first render instead of
 * queueing behind them. Idempotent — `useAuth()` still calls the same
 * initializer, which no-ops once this has run.
 */
export function startAuthBootstrap(): void {
  initAuth();
}

/**
 * Thrown by `refreshAuth()` when the resync completed but did not
 * establish an authenticated user — e.g. `getSession()` returned null
 * because of a stale Better Auth cookie. Callers that depend on a
 * session being present after `refreshAuth()` (the OIDC callback,
 * post-email-change) can catch this discriminant and show a
 * meaningful "please sign in again" message instead of navigating into a
 * silent loop.
 */
export class AuthRefreshError extends Error {
  constructor(
    public code: "no_session",
    message: string,
  ) {
    super(message);
    this.name = "AuthRefreshError";
  }
}

/**
 * Thrown by `changeEmail()` on a 409 address collision, so the caller can show
 * its dedicated "email already in use" message without reaching into the raw
 * Better Auth result shape — the seam is the only place that touches
 * `authClient`. Any other failure is thrown as a coded `ApiError`.
 */
export class EmailChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailChangeError";
  }
}

/**
 * Resync auth state from the server cookie and assert that a user was
 * established. Use after any flow that should have left a valid session
 * behind (OIDC callback, email change). On the no-user
 * path `syncAuth` already best-effort clears the stale cookie via
 * `signOut()`; this throw lets the caller surface the failure in the UI
 * rather than silently navigating onwards on a null user.
 */
export async function refreshAuth(): Promise<void> {
  await syncAuth(true);
  if (!authStore.getState().user) {
    throw new AuthRefreshError(
      "no_session",
      "Authentication did not complete — the session could not be established.",
    );
  }
}

/** `can_create_org`; `true` while the profile is unknown, so a failed read strands nobody on the waiting page. */
export function useCanCreateOrg(): boolean {
  return useStore(authStore, (s) => s.profile?.canCreateOrg ?? true);
}

export function useAuth() {
  initAuth();

  const state = useStore(authStore);

  /**
   * Email/password login — used by the OSS login form and the invite
   * acceptance flow, which authenticate inline without redirecting. In OIDC
   * mode these forms never render (`HostedAuthGate` redirects first), so
   * there is no redirect variant here — the gate owns that path.
   */
  const login = useCallback(
    // `callbackURL`: where the re-sent verification link of an unverified
    // account lands; given one, the client also navigates there on success.
    async (email: string, password: string, callbackURL?: string) => {
      rememberSignedIn(localStorage, true);
      const result = await authClient.signIn.email({ email, password, callbackURL });
      if (result.error) throw toLoginError(result.error);
      const profile = await fetchProfile();
      if (result.data?.user) {
        setAuthenticatedUser(result.data.user, profile);
      }
    },
    [],
  );

  const signup = useCallback(
    async (
      email: string,
      password: string,
      displayName: string | undefined,
      // Where the verification link lands (e.g. the invitation that asked).
      callbackURL: string,
    ): Promise<{ emailVerificationRequired: boolean }> => {
      // Native email/password signup (OSS). In OIDC mode the register form
      // never renders — `HostedAuthGate` redirects to the hosted register
      // page first — so signup has no OIDC branch; the gate owns that path.
      rememberSignedIn(localStorage, true);
      const result = await authClient.signUp.email({
        email,
        password,
        name: displayName || email,
        callbackURL,
      });
      if (result.error) throw toAuthError(result.error);
      const smtpEnabled = window.__APP_CONFIG__?.features?.smtp ?? false;
      if (!result.data?.user || (smtpEnabled && !result.data.user.emailVerified)) {
        return { emailVerificationRequired: true };
      }
      const profile = await fetchProfile();
      setAuthenticatedUser(result.data.user, profile);
      return { emailVerificationRequired: false };
    },
    [],
  );

  /**
   * Log out. `redirectTo`, when given, is where the user should land after
   * they sign in again — used by the invite "log out and retry" flow so a
   * wrong-account user returns to the invitation. In OIDC mode it is stashed
   * for the post-re-login callback (see `startOidcLogout`); in OSS mode the
   * page that called logout stays mounted (e.g. /invite re-renders into its
   * login form), so no explicit navigation is needed.
   */
  const logout = useCallback(async (redirectTo?: string) => {
    const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
    if (oidcConfig) {
      // Navigate to the server-side logout endpoint FIRST — it clears the
      // BA session cookie and redirects back to /login. Do NOT call
      // clearSession() before this: setting user=null triggers a React
      // re-render that navigates to /login (via the catch-all route),
      // which starts a new OIDC login flow before the browser can follow
      // the logout redirect — effectively re-logging the user in.
      const { startOidcLogout } = await import("../modules/oidc/lib/oidc");
      rememberSignedIn(localStorage, false);
      startOidcLogout(redirectTo);
    } else {
      await authClient.signOut();
      clearSession();
    }
  }, []);

  const updatePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
    });
    if (result.error) throw toAuthError(result.error);
  }, []);

  const signInWithSocial = useCallback(
    async (provider: "google" | "github", callbackURL?: string) => {
      rememberSignedIn(localStorage, true);
      await authClient.signIn.social({
        provider,
        callbackURL: callbackURL ?? "/",
      });
    },
    [],
  );

  const linkSocial = useCallback(async (provider: "google" | "github") => {
    await authClient.linkSocial({
      provider,
      callbackURL: "/preferences",
    });
  }, []);

  const linkGoogle = useCallback(() => linkSocial("google"), [linkSocial]);

  const linkGithub = useCallback(() => linkSocial("github"), [linkSocial]);

  /**
   * Unlink ONE linked account, named by the `id` of the row `listAccounts()`
   * returned for it — Better Auth's `account.id` primary key.
   *
   * The wire field is called `accountId`, which is a different thing from the
   * `accountId` on that same row: that one is the identifier AT THE PROVIDER
   * (a Google `sub`, a GitHub numeric id) and the endpoint never looks at it.
   * `/unlink-account` resolves the target as
   * `findAccounts(session.user.id).find((a) => a.id === accountId)`, so
   * feeding it the provider-side value simply misses and answers
   * `ACCOUNT_NOT_FOUND`.
   */
  const unlinkAccount = useCallback(async (accountRowId: string) => {
    const result = await authClient.unlinkAccount({ accountId: accountRowId });
    if (result.error) throw toUnlinkError(result.error);
  }, []);

  const resendVerificationEmail = useCallback(async (email: string, callbackURL?: string) => {
    const result = await authClient.sendVerificationEmail({ email, callbackURL });
    if (result.error) throw toAuthError(result.error);
  }, []);

  // ─── Password recovery / passwordless (OSS-only at runtime) ─────────────
  //
  // These recovery flows have no OIDC branch on purpose: when the OIDC module
  // is configured, `HostedAuthGate` / `useHostedAuthRedirect` redirect the
  // forgot-password / reset-password / magic-link routes to the hosted IdP
  // *before* their forms ever render, so these methods are only reachable in
  // OSS mode. They live on the seam (not inline in the pages) solely so the
  // ESLint `auth-client` ban can guarantee no page bypasses that redirect.

  const requestPasswordReset = useCallback(async (email: string) => {
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (result.error) throw toAuthError(result.error);
  }, []);

  const resetPassword = useCallback(async (token: string, newPassword: string) => {
    const result = await authClient.resetPassword({ newPassword, token });
    if (result.error) throw toAuthError(result.error);
  }, []);

  const startMagicLink = useCallback(async (email: string) => {
    rememberSignedIn(localStorage, true);
    const result = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
      errorCallbackURL: "/magic-link",
    });
    if (result.error) throw toAuthError(result.error);
  }, []);

  // ─── Authenticated account management (no OIDC entry redirect) ───────────
  //
  // changeEmail / listLinkedAccounts operate on the *existing* session from
  // inside the dashboard — they are not unauthenticated entry points, so they
  // run natively in both modes. Routed through the seam only for the ban.

  const changeEmail = useCallback(
    async (newEmail: string): Promise<"changed" | "confirmation_sent"> => {
      const result = await authClient.changeEmail({
        newEmail,
        callbackURL: EMAIL_CHANGE_CALLBACK_URL,
      });
      if (result.error?.status === 409) throw new EmailChangeError(result.error.message ?? "");
      if (result.error) throw toAuthError(result.error);
      if (window.__APP_CONFIG__?.features?.smtp) return "confirmation_sent";
      await refreshAuth();
      // Without SMTP the change is immediate: an address that did not move was taken.
      if (!emailWasChanged(newEmail, authStore.getState().user?.email)) {
        throw new EmailChangeError("");
      }
      return "changed";
    },
    [],
  );

  const listLinkedAccounts = useCallback(async () => {
    const result = await authClient.listAccounts();
    if (result.error) throw toAuthError(result.error);
    return result.data ?? [];
  }, []);

  return {
    user: state.user,
    profile: state.profile,
    loading: state.loading,
    login,
    signup,
    logout,
    updatePassword,
    signInWithSocial,
    linkSocial,
    linkGoogle,
    linkGithub,
    unlinkAccount,
    resendVerificationEmail,
    requestPasswordReset,
    resetPassword,
    startMagicLink,
    changeEmail,
    listLinkedAccounts,
  };
}
