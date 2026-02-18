import type { Context, Next } from "hono";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { supabase } from "../lib/supabase.ts";

/**
 * Middleware: extract X-Org-Id header, verify membership, inject orgId + orgRole.
 * Returns 400 if header is missing, 403 if user is not a member of the org.
 */
export function requireOrgContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const orgId = c.req.header("X-Org-Id");
    if (!orgId) {
      return c.json({ error: "MISSING_ORG_CONTEXT", message: "Header X-Org-Id est requis" }, 400);
    }

    const user = c.get("user");
    const { data } = await supabase
      .from("organization_members")
      .select("role")
      .eq("org_id", orgId)
      .eq("user_id", user.id)
      .single();

    if (!data) {
      return c.json(
        { error: "FORBIDDEN", message: "Vous n'etes pas membre de cette organisation" },
        403,
      );
    }

    c.set("orgId", orgId);
    c.set("orgRole", data.role as OrgRole);
    return next();
  };
}
