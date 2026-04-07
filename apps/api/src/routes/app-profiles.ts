// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, applicationPackages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import {
  getProfileForActor,
  listAppProfiles,
  createAppProfile,
  getAppProfile,
  renameAppProfile,
  deleteAppProfile,
  listAppProfilesWithUserBindings,
  getOrgMemberProfile,
} from "../services/connection-profiles.ts";
import {
  listAllActorConnections,
  deleteAllActorConnections,
  hasActiveConnection,
} from "../services/connection-manager/index.ts";
import {
  getAppProfileBindingsEnriched,
  bindAppProfileProvider,
  unbindAppProfileProvider,
  getBindingOwner,
} from "../services/state/index.ts";
import { getActor } from "../lib/actor.ts";

import { rateLimit } from "../middleware/rate-limit.ts";
import { listConnections, listProviderCredentialIds } from "@appstrate/connect";

export const profileNameSchema = z.object({ name: z.string().min(1, "Name is required").max(100) });
export const bindAppProfileSchema = z.object({
  providerId: z.string().min(1),
  sourceProfileId: z.uuid(),
});

async function requireAppProfile(profileId: string, applicationId: string) {
  const profile = await getAppProfile(profileId, applicationId);
  if (!profile) throw notFound("Profile not found");
  return profile;
}

export function createAppProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/app-profiles/connections — all connections across all profiles
  router.get("/connections", async (c) => {
    const actor = getActor(c);
    const result = await listAllActorConnections(actor);
    return c.json(result);
  });

  // DELETE /api/app-profiles/connections — delete all actor connections (app-scoped)
  router.delete("/connections", async (c) => {
    const actor = getActor(c);
    const applicationId = c.get("applicationId");
    await deleteAllActorConnections(actor, applicationId);
    return c.json({ ok: true });
  });

  // GET /api/app-profiles/my-bindings — list app profiles where current user has bindings
  router.get("/my-bindings", async (c) => {
    const userId = c.get("user").id;
    const applicationId = c.get("applicationId");
    const profiles = await listAppProfilesWithUserBindings(userId, applicationId);
    return c.json({ profiles });
  });

  // GET /api/app-profiles — list app profiles
  router.get("/", async (c) => {
    const applicationId = c.get("applicationId");
    const profiles = await listAppProfiles(applicationId);
    return c.json({ profiles });
  });

  // POST /api/app-profiles — create an app profile
  router.post("/", rateLimit(10), requirePermission("app-profiles", "write"), async (c) => {
    const applicationId = c.get("applicationId");
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createAppProfile(applicationId, data.name.trim());
    return c.json({ profile }, 201);
  });

  // PUT /api/app-profiles/:id — rename an app profile
  router.put("/:id", requirePermission("app-profiles", "write"), async (c) => {
    const applicationId = c.get("applicationId");
    const profileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameAppProfile(profileId, applicationId, data.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename app profile", { profileId, applicationId, error: message });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/app-profiles/:id — delete an app profile
  router.delete("/:id", requirePermission("app-profiles", "delete"), async (c) => {
    const applicationId = c.get("applicationId");
    const profileId = c.req.param("id")!;
    try {
      await deleteAppProfile(profileId, applicationId);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete app profile", { profileId, applicationId, error: message });
      throw invalidRequest(message);
    }
  });

  // GET /api/app-profiles/:id/agents — list agents using this app profile
  router.get("/:id/agents", async (c) => {
    const applicationId = c.get("applicationId");
    const profileId = c.req.param("id")!;
    await requireAppProfile(profileId, applicationId);

    const rows = await db
      .select({
        id: packages.id,
        displayName: sql<string>`${packages.draftManifest}->>'displayName'`,
      })
      .from(applicationPackages)
      .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
      .where(eq(applicationPackages.appProfileId, profileId));

    return c.json({ agents: rows });
  });

  // GET /api/app-profiles/:id/bindings — list provider bindings for an app profile
  router.get("/:id/bindings", async (c) => {
    const applicationId = c.get("applicationId");
    const profileId = c.req.param("id")!;
    await requireAppProfile(profileId, applicationId);
    const bindings = await getAppProfileBindingsEnriched(profileId, applicationId);
    return c.json({ bindings });
  });

  // POST /api/app-profiles/:id/bind — bind a provider to a user's connection
  router.post("/:id/bind", rateLimit(10), requirePermission("app-profiles", "bind"), async (c) => {
    const applicationId = c.get("applicationId");
    const orgId = c.get("orgId");
    const userId = c.get("user").id;
    const profileId = c.req.param("id")!;
    await requireAppProfile(profileId, applicationId);

    const body = await c.req.json();
    const data = parseBody(bindAppProfileSchema, body);

    // Verify source profile belongs to the requesting user
    const actor = getActor(c);
    const sourceProfile = await getProfileForActor(data.sourceProfileId, actor);
    if (!sourceProfile) {
      throw invalidRequest("Source profile not found or does not belong to you");
    }

    // Ownership check: can't overwrite another user's binding without app-profiles:write
    const existingOwner = await getBindingOwner(profileId, data.providerId);
    if (existingOwner && existingOwner !== userId) {
      const perms = c.get("permissions");
      if (!perms?.has("app-profiles:write")) {
        throw forbidden("Cannot overwrite a binding created by another member");
      }
    }

    // Verify the source profile has an active connection for this provider in this application
    const connected = await hasActiveConnection(
      data.providerId,
      data.sourceProfileId,
      orgId,
      applicationId,
    );
    if (!connected) {
      throw invalidRequest(
        `No active connection for '${data.providerId}' on the source profile in this application`,
      );
    }

    await bindAppProfileProvider(profileId, data.providerId, data.sourceProfileId, userId);
    return c.json({ bound: true });
  });

  // DELETE /api/app-profiles/:id/bind/:providerScope/:providerName — unbind a provider
  router.delete(
    "/:id/bind/:providerScope{@[^/]+}/:providerName",
    requirePermission("app-profiles", "bind"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const userId = c.get("user").id;
      const profileId = c.req.param("id")!;
      const providerId = `${c.req.param("providerScope")}/${c.req.param("providerName")}`;
      await requireAppProfile(profileId, applicationId);

      // Ownership check: can't unbind another user's binding without app-profiles:write
      const existingOwner = await getBindingOwner(profileId, providerId);
      if (existingOwner && existingOwner !== userId) {
        const perms = c.get("permissions");
        if (!perms?.has("app-profiles:write")) {
          throw forbidden("Cannot unbind a connection bound by another member");
        }
      }

      await unbindAppProfileProvider(profileId, providerId);
      return c.json({ unbound: true });
    },
  );

  // GET /api/app-profiles/:id/connections — list connections for a profile
  router.get("/:id/connections", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // Allow access if: own profile, app profile, or profile of another org member (read-only view)
    const profile =
      (await getProfileForActor(profileId, actor)) ??
      (await getAppProfile(profileId, applicationId)) ??
      (await getOrgMemberProfile(profileId, orgId));
    if (!profile) {
      throw notFound("Profile not found");
    }
    // Scope connections to the application's credentials
    const credentialIds = applicationId ? await listProviderCredentialIds(db, applicationId) : [];
    const rawConnections = await listConnections(db, profileId, orgId, credentialIds);
    // Strip sensitive fields — never expose encrypted credentials to the client
    const connections = rawConnections.map(
      ({ credentialsEncrypted: _ce, providerCredentialId: _pc, expiresAt: _ex, ...c }) => c,
    );
    return c.json({ connections });
  });

  return router;
}
