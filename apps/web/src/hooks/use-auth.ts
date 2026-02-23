import { useSyncExternalStore, useCallback, useEffect } from "react";
import { authClient } from "../lib/auth-client";
import { api } from "../api";
import i18n from "../i18n";
import type { Profile } from "@appstrate/shared-types";

interface AuthState {
  user: { id: string; email: string; name?: string } | null;
  profile: Profile | null;
  loading: boolean;
}

let _authState: AuthState = { user: null, profile: null, loading: true };
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot() {
  return _authState;
}

function setState(next: AuthState) {
  _authState = next;
  for (const fn of listeners) fn();
}

async function fetchProfile(): Promise<Profile | null> {
  try {
    const data = await api<{ id: string; display_name: string; language: string }>("/profile");
    const language = data.language === "fr" || data.language === "en" ? data.language : "fr";
    const profile: Profile = {
      id: data.id,
      displayName: data.display_name,
      language,
      createdAt: null,
      updatedAt: null,
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
  user: { id: string; email: string; name: string },
  profile: Profile | null,
) {
  setState({ user: { id: user.id, email: user.email, name: user.name }, profile, loading: false });
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;

  // Check initial session
  authClient
    .getSession()
    .then(async (result) => {
      if (result.data?.user) {
        const profile = await fetchProfile();
        setAuthenticatedUser(result.data.user, profile);
      } else {
        setState({ user: null, profile: null, loading: false });
      }
    })
    .catch(() => {
      setState({ user: null, profile: null, loading: false });
    });
}

export function useAuth() {
  initAuth();

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Listen for session changes
  useEffect(() => {
    const unsub = authClient.$store.listen("$sessionSignal", async () => {
      const result = await authClient.getSession();
      if (result.data?.user) {
        const profile = await fetchProfile();
        setAuthenticatedUser(result.data.user, profile);
      } else {
        setState({ user: null, profile: null, loading: false });
      }
    });
    return typeof unsub === "function" ? unsub : () => {};
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authClient.signIn.email({ email, password });
    if (result.error) throw new Error(result.error.message);
    // Fetch profile after login
    const profile = await fetchProfile();
    if (result.data?.user) {
      setAuthenticatedUser(result.data.user, profile);
    }
  }, []);

  const signup = useCallback(async (email: string, password: string, displayName?: string) => {
    const result = await authClient.signUp.email({
      email,
      password,
      name: displayName || email,
    });
    if (result.error) throw new Error(result.error.message);
    // Fetch profile after signup
    const profile = await fetchProfile();
    if (result.data?.user) {
      setAuthenticatedUser(result.data.user, profile);
    }
  }, []);

  const logout = useCallback(async () => {
    await authClient.signOut();
    setState({ user: null, profile: null, loading: false });
  }, []);

  const updatePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
    });
    if (result.error) throw new Error(result.error.message);
  }, []);

  return {
    user: state.user,
    profile: state.profile,
    loading: state.loading,
    login,
    signup,
    logout,
    updatePassword,
  };
}
