import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { providerConfigs } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { getProviderTemplates } from "../services/provider-templates.ts";
import { getBuiltInProviders } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";

export function createProviderTemplatesRouter() {
  const router = new Hono<AppEnv>();

  router.use("*", requireAdmin());

  // GET /api/provider-templates — list available templates (filtered)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const templates = getProviderTemplates();
    const builtIn = getBuiltInProviders();

    // Fetch existing custom provider IDs for this org
    const rows = await db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(eq(providerConfigs.orgId, orgId));
    const customIds = new Set(rows.map((r) => r.id));

    // Filter out templates whose templateId already exists as built-in or custom
    let available = templates.filter(
      (t) => !builtIn.has(t.templateId) && !customIds.has(t.templateId),
    );

    // Text search across displayName, description, categories, authMode
    if (search) {
      available = available.filter(
        (t) =>
          t.displayName.toLowerCase().includes(search) ||
          t.description.toLowerCase().includes(search) ||
          t.authMode.toLowerCase().includes(search) ||
          t.categories?.some((cat) => cat.toLowerCase().includes(search)),
      );
    }

    const env = getEnv();
    const callbackUrl = env.OAUTH_CALLBACK_URL || env.APP_URL + "/auth/callback";

    return c.json({ templates: available, callbackUrl });
  });

  return router;
}
