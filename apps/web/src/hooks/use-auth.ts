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

/** Start the session resync at boot (from `main.tsx`, before `createRoot`) so it overlaps the locale fetch and first render. Idempotent. */
export function startAuthBootstrap(): void {
  initAuth();
}

/** Thrown by `refreshAuth()` when the resync established no user (e.g. a stale Better Auth cookie), so callers can show "sign in again" instead of looping. */
export class AuthRefreshError extends Error {
  constructor(
    public code: "no_session",
    message: string,
  ) {
    super(message);
    this.name = "AuthRefreshError";
  }
}

/** Thrown by `changeEmail()` on a 409 address collision (this seam is the only place touching `authClient`); other failures are coded `ApiError`s. */
export class EmailChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailChangeError";
  }
}

/** Resync auth state from the server cookie and assert a user was established (after OIDC callback, email change). `syncAuth` already clears a stale cookie; the throw surfaces the failure. */
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

  // Email/password login (OSS form, invite acceptance). In OIDC mode these forms never render
  // (`HostedAuthGate` redirects first), so there is no OIDC branch here.
  const login = useCallback(
    // `callbackURL`: where an unverified account's re-sent verification link lands.
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
      // OSS only: in OIDC mode `HostedAuthGate` redirects before the register form renders.
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

  // `redirectTo` is where the user lands after signing in again (invite "log out and retry"); in
  // OIDC mode it is stashed for the post-re-login callback (`startOidcLogout`).
  const logout = useCallback(async (redirectTo?: string) => {
    const oidcConfig = (window.__APP_CONFIG__ as unknown as Record<string, unknown>)?.oidc;
    if (oidcConfig) {
      // Navigate to the server-side logout FIRST. Do NOT call clearSession() before: user=null
      // re-renders to /login, which starts a new OIDC login before the logout redirect —
      // re-logging the user in.
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
   * Unlink ONE account by the `id` of its `listAccounts()` row (Better Auth's primary key). The
   * wire field `accountId` is NOT the row's `accountId` (the provider-side id): feeding it that
   * misses and answers `ACCOUNT_NOT_FOUND`.
   */
  const unlinkAccount = useCallback(async (accountRowId: string) => {
    const result = await authClient.unlinkAccount({ accountId: accountRowId });
    if (result.error) throw toUnlinkError(result.error);
  }, []);

  const resendVerificationEmail = useCallback(async (email: string, callbackURL?: string) => {
    const result = await authClient.sendVerificationEmail({ email, callbackURL });
    if (result.error) throw toAuthError(result.error);
  }, []);

  // Password recovery / passwordless: no OIDC branch on purpose (`HostedAuthGate` redirects those
  // routes first, so only OSS mode reaches them). On the seam so the ESLint `auth-client` ban holds.

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

  // changeEmail / listLinkedAccounts act on the existing session, so they run natively in both modes.

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
