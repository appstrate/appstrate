import { createClient } from "@supabase/supabase-js";
import type { Database } from "@appstrate/shared-types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Bypass navigator.locks to avoid deadlocks with session refresh
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<unknown>) => await fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
});
