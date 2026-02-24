import { useCallback } from "react";
import { useStore } from "zustand";
import { authClient } from "../lib/auth-client";
import { api } from "../api";
import { authStore } from "../stores/auth-store";
import i18n from "../i18n";
import type { Profile } from "@appstrate/shared-types";

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

function clearAuth() {
  authStore.setState({ user: null, profile: null, loading: false });
}

function setAuthenticatedUser(
  user: { id: string; email: string; name: string },
  profile: Profile | null,
) {
  authStore.setState({
    user: { id: user.id, email: user.email, name: user.name },
    profile,
    loading: false,
  });
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;

  authClient
    .getSession()
    .then(async (result) => {
      if (result.data?.user) {
        const profile = await fetchProfile();
        setAuthenticatedUser(result.data.user, profile);
      } else {
        clearAuth();
      }
    })
    .catch(() => {
      clearAuth();
    });
}

export async function refreshAuth() {
  const result = await authClient.getSession();
  if (result.data?.user) {
    const profile = await fetchProfile();
    setAuthenticatedUser(result.data.user, profile);
  } else {
    clearAuth();
  }
}

export function useAuth() {
  initAuth();

  const state = useStore(authStore);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authClient.signIn.email({ email, password });
    if (result.error) throw new Error(result.error.message);
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
    const profile = await fetchProfile();
    if (result.data?.user) {
      setAuthenticatedUser(result.data.user, profile);
    }
  }, []);

  const logout = useCallback(async () => {
    await authClient.signOut();
    clearAuth();
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
