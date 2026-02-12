import { useState, useEffect, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Profile } from "@appstrate/shared-types";

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
}

let _authState: AuthState = {
  session: null,
  user: null,
  profile: null,
  loading: true,
};
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  return data ?? null;
}

// Initialize auth listener once
let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;

  supabase.auth.getSession().then(async ({ data: { session } }) => {
    _authState = {
      session,
      user: session?.user ?? null,
      profile: session?.user ? await fetchProfile(session.user.id) : null,
      loading: false,
    };
    notify();
  });

  supabase.auth.onAuthStateChange(async (_event, session) => {
    _authState = {
      session,
      user: session?.user ?? null,
      profile: session?.user ? await fetchProfile(session.user.id) : null,
      loading: false,
    };
    notify();
  });
}

export function useAuth() {
  initAuth();

  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signup = useCallback(async (email: string, password: string, displayName?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return {
    session: _authState.session,
    user: _authState.user,
    profile: _authState.profile,
    loading: _authState.loading,
    isAdmin: _authState.profile?.role === "admin",
    login,
    signup,
    logout,
  };
}
