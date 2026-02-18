import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger.ts";
import type { Database } from "@appstrate/shared-types";

const supabaseUrl = process.env.SUPABASE_URL || "http://localhost:8000";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!serviceRoleKey) {
  logger.warn("SUPABASE_SERVICE_ROLE_KEY is not set — DB operations will fail");
}

export const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function getUserProfile(userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", userId)
    .single();
  return data ?? null;
}

export async function ensureBucket(name: string): Promise<void> {
  const { data } = await supabase.storage.getBucket(name);
  if (!data) {
    const { error } = await supabase.storage.createBucket(name, { public: false });
    if (error) {
      logger.error("Failed to create storage bucket", { bucket: name, error: error.message });
      throw error;
    }
    logger.info("Created storage bucket", { bucket: name });
  }
}
