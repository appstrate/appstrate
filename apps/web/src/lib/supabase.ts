import { createClient } from "@supabase/supabase-js";
import type { Database } from "@appstrate/shared-types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "http://localhost:8000";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
