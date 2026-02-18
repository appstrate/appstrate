import { useSyncExternalStore, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Profile } from "@appstrate/shared-types";

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
}

let _authState: AuthState = { session: null, user: null, profile: null, loading: true };
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

async function resolveSession(session: Session | null) {
  let profile: Profile | null = null;
  if (session?.user) {
    const { data, status } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .single<Profile>();
    if (status === 406) {
      await supabase.auth.signOut();
      setState({ session: null, user: null, profile: null, loading: false });
      return;
    }
    profile = data ?? null;
  }
  setState({ session, user: session?.user ?? null, profile, loading: false });
}

let initialized = false;
function initAuth() {
  if (initialized) return;
  initialized = true;

  supabase.auth
    .getSession()
    .then(({ data: { session } }) => resolveSession(session))
    .catch(() => {
      setState({ session: null, user: null, profile: null, loading: false });
    });

  supabase.auth.onAuthStateChange((_event, session) => {
    void resolveSession(session);
  });
}

export function useAuth() {
  initAuth();

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

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
    session: state.session,
    user: state.user,
    profile: state.profile,
    loading: state.loading,
    login,
    signup,
    logout,
  };
}
