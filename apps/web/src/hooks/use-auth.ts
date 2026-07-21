// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { authClient } from "../lib/auth-client";
import { client } from "../api/client";
import { authStore, type AuthProfile } from "../stores/auth-store";
import { toUnlinkError } from "../lib/auth-errors";
import { orgStore } from "../stores/org-store";
import { appStore } from "../stores/app-store";
import i18n from "../i18n";

async function fetchProfile(): Promise<AuthProfile | null> {
  try {
    const { data } = await client.GET("/api/profile");
    if (!data) return null;
    const profile: AuthProfile = {
      id: data.id,
      displayName: data.displayName ?? null,
      language: data.language,
    };
    if (profile.language && profile.language !== i18n.language) {
      i18n.changeLanguage(profile.language);
    }
    return profile;
  } catch {
    return null;
  }
}

/**
 * Centralized session teardown. Resets the auth store AND the org/app scope
 * stores (clearing their persisted localStorage ids) so a subsequent login
 * can never carry over a stale `X-Org-Id` / `X-Application-Id` header from
 * the previous user — the scoping-header builder reads straight off these
 * stores, so leaving them set would leak the old scope onto the first
 * requests after re-login.
 */
function clearSession() {
  authStore.setState({ user: null, profile: null, loading: false });
  orgStore.getState().setId(null);
  appStore.getState().setId(null);
}

function setAuthenticatedUser(
  user: { id: string; email: string; emailVerified: boolean; name: string },
  profile: AuthProfile | null,
) {
  authStore.setState({
    user: { id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name },
    profile,
    loading: false,
  });
}

async function syncAuth() {
  const result = await authClient.getSession();
  if (result.data?.user) {
    const profile = await fetchProfile();
    if (!profile) {
      await authClient.signOut().catch(() => {});
      clearSession();
      return;
    }
    setAuthenticatedUser(result.data.user, profile);
  } else {
    // No active session. The browser may still be carrying a stale BA
    // cookie (signature invalid after `BETTER_AUTH_SECRET` rotation, session
    // row gone after a redeploy, partition / domain mismatch from a config
    // change, …). BA's `/get-session` returns null silently in that case
    // *without* clearing the bad cookie, so it would keep re-arriving on
    // every request and the user would bounce between `/login` and
    // `/auth/callback` forever with no surfaceable error.
    //
    // `signOut()` deterministically tells the server to emit
    // `Set-Cookie: …; Max-Age=0` for every BA cookie it knows about,
    // matching the original Path/Domain/Partitioned so the browser
    // actually drops them. The cost is one extra HTTP round-trip on a
    // cold session-less load — acceptable for the recovery guarantee.
    await authClient.signOut().catch(() => {
      // Best-effort: a failing signOut (network blip, already-cleared
      // cookie) must not strand the user. `clearSession` below still resets
      // the SPA stores so the login flow restarts cleanly.
    });
    clearSession();
  }
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;
  syncAuth().catch(() => {
    clearSession();
  });
}

/**
 * Thrown by `refreshAuth()` when the resync completed but did not
 * establish an authenticated user — e.g. `getSession()` returned null
 * because of a stale Better Auth cookie. Callers that depend on a
 * session being present after `refreshAuth()` (the OIDC callback, invite
 * acceptance, post-email-change) can catch this discriminant and show a
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
 * Thrown by `changeEmail()` so the caller can distinguish a 409 address
 * collision (a dedicated "email already in use" message) from any other
 * failure without reaching into the raw Better Auth result shape — the
 * seam is the only place that touches `authClient`.
 */
export class EmailChangeError extends Error {
  constructor(
    public conflict: boolean,
    message: string,
  ) {
    super(message);
    this.name = "EmailChangeError";
  }
}

/**
 * Resync auth state from the server cookie and assert that a user was
 * established. Use after any flow that should have left a valid session
 * behind (OIDC callback, invite accept, email change). On the no-user
 * path `syncAuth` already best-effort clears the stale cookie via
 * `signOut()`; this throw lets the caller surface the failure in the UI
 * rather than silently navigating onwards on a null user.
 */
export async function refreshAuth(): Promise<void> {
  await syncAuth();
  if (!authStore.getState().user) {
    throw new AuthRefreshError(
      "no_session",
      "Authentication did not complete — the session could not be established.",
    );
  }
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
  const login = useCallback(async (email: string, password: string) => {
    const result = await authClient.signIn.email({ email, password });
    if (result.error) throw new Error(result.error.message);
    const profile = await fetchProfile();
    if (result.data?.user) {
      setAuthenticatedUser(result.data.user, profile);
    }
  }, []);

  const signup = useCallback(
    async (
      email: string,
      password: string,
      displayName?: string,
    ): Promise<{ emailVerificationRequired: boolean }> => {
      // Native email/password signup (OSS). In OIDC mode the register form
      // never renders — `HostedAuthGate` redirects to the hosted register
      // page first — so signup has no OIDC branch; the gate owns that path.
      const result = await authClient.signUp.email({
        email,
        password,
        name: displayName || email,
      });
      if (result.error) throw new Error(result.error.message);
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
    if (result.error) throw new Error(result.error.message);
  }, []);

  const signInWithSocial = useCallback(
    async (provider: "google" | "github", callbackURL?: string) => {
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

  const unlinkAccount = useCallback(async (providerId: string) => {
    const result = await authClient.unlinkAccount({ providerId });
    if (result.error) throw toUnlinkError(result.error);
  }, []);

  const resendVerificationEmail = useCallback(async (email: string) => {
    const result = await authClient.sendVerificationEmail({ email });
    if (result.error) throw new Error(result.error.message);
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
    if (result.error) throw new Error(result.error.message);
  }, []);

  const resetPassword = useCallback(async (token: string, newPassword: string) => {
    const result = await authClient.resetPassword({ newPassword, token });
    if (result.error) throw new Error(result.error.message);
  }, []);

  const startMagicLink = useCallback(async (email: string) => {
    const result = await authClient.signIn.magicLink({ email, callbackURL: "/" });
    if (result.error) throw new Error(result.error.message);
  }, []);

  // ─── Authenticated account management (no OIDC entry redirect) ───────────
  //
  // changeEmail / listLinkedAccounts operate on the *existing* session from
  // inside the dashboard — they are not unauthenticated entry points, so they
  // run natively in both modes. Routed through the seam only for the ban.

  const changeEmail = useCallback(async (newEmail: string) => {
    const result = await authClient.changeEmail({ newEmail });
    if (result.error) {
      throw new EmailChangeError(result.error.status === 409, result.error.message ?? "");
    }
  }, []);

  const listLinkedAccounts = useCallback(async () => {
    const result = await authClient.listAccounts();
    if (result.error) throw new Error(result.error.message);
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
