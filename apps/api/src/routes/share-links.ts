/**
 * Share Links API — CRUD for managing share links on flows.
 * All routes require admin auth + flow context.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import {
  createShareLink,
  listShareLinks,
  getShareLinkById,
  updateShareLink,
  deleteShareLink,
  listShareLinkUsages,
} from "../services/share-links.ts";
import { getFlowProviderBindings } from "../services/state/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { resolveVersionManifest } from "../services/package-versions.ts";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { getActor } from "../lib/actor.ts";

const createShareLinkSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  version: z.string().optional(),
});

const updateShareLinkSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
});

export function createShareLinksRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/flows/:scope/:name/share-links — list share links for this flow
  router.get(
    "/:scope{@[^/]+}/:name/share-links",
    rateLimit(300),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const links = await listShareLinks(flow.id, orgId);
      return c.json({ object: "list", data: links });
    },
  );

  // POST /api/flows/:scope/:name/share-links — create a share link
  router.post(
    "/:scope{@[^/]+}/:name/share-links",
    rateLimit(10),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const body = await c.req.json().catch(() => ({}));
      const parsed = createShareLinkSchema.safeParse(body);
      if (!parsed.success) {
        throw invalidRequest(parsed.error.issues[0]!.message);
      }

      // Resolve manifest to snapshot
      let manifest = flow.manifest as Record<string, unknown>;
      if (parsed.data.version && flow.source !== "system") {
        const versionManifest = await resolveVersionManifest(flow.id, parsed.data.version);
        if (!versionManifest) {
          throw notFound(`Version '${parsed.data.version}' not found`);
        }
        manifest = versionManifest;
      }

      // Verify the flow is shareable publicly
      const providers = resolveManifestProviders(manifest as typeof flow.manifest);
      if (providers.length > 0) {
        const userModeService = providers.find((s) => (s.connectionMode ?? "user") === "user");
        if (userModeService) {
          throw invalidRequest(
            "This flow cannot be shared publicly because it requires user-mode connections.",
          );
        }

        const bindings = await getFlowProviderBindings(orgId, flow.id);
        for (const svc of providers) {
          if (!bindings[svc.id]) {
            throw invalidRequest(
              "All admin providers must be bound before generating a public link.",
            );
          }
        }
      }

      const actor = getActor(c);
      const link = await createShareLink(flow.id, actor, orgId, {
        manifest,
        label: parsed.data.label ?? undefined,
        maxUses: parsed.data.maxUses ?? undefined,
        expiresInDays: parsed.data.expiresInDays,
      });

      return c.json(link, 201);
    },
  );

  // GET /api/flows/:scope/:name/share-links/:linkId — get share link detail
  router.get(
    "/:scope{@[^/]+}/:name/share-links/:linkId",
    rateLimit(300),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const orgId = c.get("orgId");
      const linkId = c.req.param("linkId")!;
      const link = await getShareLinkById(linkId, orgId);
      if (!link) throw notFound("Share link not found.");
      return c.json(link);
    },
  );

  // PATCH /api/flows/:scope/:name/share-links/:linkId — update share link
  router.patch(
    "/:scope{@[^/]+}/:name/share-links/:linkId",
    rateLimit(10),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const orgId = c.get("orgId");
      const linkId = c.req.param("linkId")!;
      const body = await c.req.json();
      const parsed = updateShareLinkSchema.safeParse(body);
      if (!parsed.success) {
        throw invalidRequest(parsed.error.issues[0]!.message);
      }

      const updates: Parameters<typeof updateShareLink>[2] = {};
      if (parsed.data.label !== undefined) updates.label = parsed.data.label;
      if (parsed.data.maxUses !== undefined) updates.maxUses = parsed.data.maxUses;
      if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
      if (parsed.data.expiresAt !== undefined) updates.expiresAt = new Date(parsed.data.expiresAt);

      const link = await updateShareLink(linkId, orgId, updates);
      if (!link) throw notFound("Share link not found.");
      return c.json(link);
    },
  );

  // DELETE /api/flows/:scope/:name/share-links/:linkId — delete share link
  router.delete(
    "/:scope{@[^/]+}/:name/share-links/:linkId",
    rateLimit(10),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const orgId = c.get("orgId");
      const linkId = c.req.param("linkId")!;
      const deleted = await deleteShareLink(linkId, orgId);
      if (!deleted) throw notFound("Share link not found.");
      return c.body(null, 204);
    },
  );

  // GET /api/flows/:scope/:name/share-links/:linkId/usages — list usages
  router.get(
    "/:scope{@[^/]+}/:name/share-links/:linkId/usages",
    rateLimit(300),
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const orgId = c.get("orgId");
      const linkId = c.req.param("linkId")!;

      // Verify link belongs to this org
      const link = await getShareLinkById(linkId, orgId);
      if (!link) throw notFound("Share link not found.");

      const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
      const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

      const usages = await listShareLinkUsages(linkId, limit, offset);
      return c.json({ object: "list", data: usages });
    },
  );

  return router;
}
