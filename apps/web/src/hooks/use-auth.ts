// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { authClient } from "../lib/auth-client";
import { api } from "../api";
import { authStore } from "../stores/auth-store";
import i18n from "../i18n";
import type { Profile } from "@appstrate/shared-types";

async function fetchProfile(): Promise<Profile | null> {
  try {
    const data = await api<{ id: string; displayName: string; language: string }>("/profile");
    const language = data.language === "fr" || data.language === "en" ? data.language : "fr";
    const profile: Profile = {
      id: data.id,
      displayName: data.displayName,
      language,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (profile.language && profile.language !== i18n.language) {
      i18n.changeLanguage(profile.language);
    }
    return profile;
  } catch {
    return null;
  }
}

function clearAuth() {
  authStore.setState({ user: null, profile: null, loading: false });
}

function setAuthenticatedUser(
  user: { id: string; email: string; emailVerified: boolean; name: string },
  profile: Profile | null,
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
      clearAuth();
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
      // cookie) must not strand the user. `clearAuth` below still resets
      // the SPA store so the login flow restarts cleanly.
    });
    clearAuth();
  }
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;
  syncAuth().catch(() => {
    clearAuth();
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
   * Login — redirects to the OIDC authorize endpoint which shows the
   * shared server-rendered login page. After authentication, the browser
   * is redirected back to /auth/callback with an authorization code.
   *
   * The optional `redirectTo` is saved for after the callback completes.
   *
   * The single-argument shape (vs. the old `(email, password)`) is
   * deliberate — any remaining inline email/password caller must use
   * `loginDirect` explicitly and the compiler flags the miswire rather
   * than silently coercing an email into `redirectTo`.
   */
  const login = useCallback((redirectTo?: string): Promise<void> => {
    const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
    if (oidcConfig) {
      return import("../modules/oidc/lib/oidc").then(({ startOidcLogin }) =>
        startOidcLogin(redirectTo),
      );
    }
    window.location.assign("/login");
    return Promise.resolve();
  }, []);

  /**
   * Direct email/password login — used by invite acceptance flow
   * where the user must authenticate inline without redirecting.
   */
  const loginDirect = useCallback(async (email: string, password: string) => {
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
      // When OIDC is loaded, signup must traverse the same server-rendered
      // flow as login so that (a) both events go through the centralized
      // branded page and (b) the resulting BA session is established under
      // the same cookie domain as the authorize callback. The server-side
      // `/api/oauth/register` handler forwards to `/oauth2/authorize` on
      // success, so the callback lands on `/auth/callback` like any login.
      const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
      if (oidcConfig) {
        const { startOidcSignup } = await import("../modules/oidc/lib/oidc");
        await startOidcSignup();
        // Page is navigating away — return a never-resolving promise so
        // callers (`onSuccess` handlers, route navigations) cannot fire
        // mid-unload and trigger a no-op state update on a detached tree.
        return new Promise<never>(() => {});
      }

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

  const logout = useCallback(async () => {
    const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
    if (oidcConfig) {
      // Navigate to the server-side logout endpoint FIRST — it clears the
      // BA session cookie and redirects back to /login. Do NOT call
      // clearAuth() before this: setting user=null triggers a React
      // re-render that navigates to /login (via the catch-all route),
      // which starts a new OIDC login flow before the browser can follow
      // the logout redirect — effectively re-logging the user in.
      const { startOidcLogout } = await import("../modules/oidc/lib/oidc");
      startOidcLogout();
    } else {
      await authClient.signOut();
      clearAuth();
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

  const signInWithGoogle = useCallback(
    (callbackURL?: string) => signInWithSocial("google", callbackURL),
    [signInWithSocial],
  );

  const signInWithGithub = useCallback(
    (callbackURL?: string) => signInWithSocial("github", callbackURL),
    [signInWithSocial],
  );

  const linkGoogle = useCallback(() => linkSocial("google"), [linkSocial]);

  const linkGithub = useCallback(() => linkSocial("github"), [linkSocial]);

  const unlinkAccount = useCallback(async (providerId: string) => {
    const result = await authClient.unlinkAccount({ providerId });
    if (result.error) throw new Error(result.error.message);
  }, []);

  const resendVerificationEmail = useCallback(async (email: string) => {
    const result = await authClient.sendVerificationEmail({ email });
    if (result.error) throw new Error(result.error.message);
  }, []);

  return {
    user: state.user,
    profile: state.profile,
    loading: state.loading,
    login,
    loginDirect,
    signup,
    logout,
    updatePassword,
    signInWithSocial,
    signInWithGoogle,
    signInWithGithub,
    linkSocial,
    linkGoogle,
    linkGithub,
    unlinkAccount,
    resendVerificationEmail,
  };
}
