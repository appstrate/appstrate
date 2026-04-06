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
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  getProfileForActor,
  listOrgProfiles,
  createOrgProfile,
  getOrgProfile,
  renameOrgProfile,
  deleteOrgProfile,
  listOrgProfilesWithUserBindings,
  getOrgMemberProfile,
} from "../services/connection-profiles.ts";
import {
  listAllActorConnections,
  deleteAllActorConnections,
  hasActiveConnection,
} from "../services/connection-manager/index.ts";
import {
  getOrgProfileBindingsEnriched,
  bindOrgProfileProvider,
  unbindOrgProfileProvider,
  getBindingOwner,
} from "../services/state/index.ts";
import { getActor } from "../lib/actor.ts";

import { rateLimit } from "../middleware/rate-limit.ts";
import { listConnections, listProviderCredentialIds } from "@appstrate/connect";

const profileNameSchema = z.object({ name: z.string().min(1, "Name is required").max(100) });

async function requireOrgProfile(profileId: string, orgId: string) {
  const profile = await getOrgProfile(profileId, orgId);
  if (!profile) throw notFound("Profile not found");
  return profile;
}

export function createConnectionProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/connection-profiles — list actor's profiles with connection counts
  router.get("/", async (c) => {
    const actor = getActor(c);
    const profiles = await listProfiles(actor);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles — create a new profile
  router.post("/", rateLimit(10), async (c) => {
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createProfile(actor, data.name.trim());
    return c.json({ profile }, 201);
  });

  // GET /api/connection-profiles/connections — all connections across all profiles
  router.get("/connections", async (c) => {
    const actor = getActor(c);
    const applicationId = c.get("applicationId");
    const result = await listAllActorConnections(actor, applicationId);
    return c.json(result);
  });

  // DELETE /api/connection-profiles/connections — delete all actor connections
  router.delete("/connections", async (c) => {
    const actor = getActor(c);
    await deleteAllActorConnections(actor);
    return c.json({ ok: true });
  });

  // GET /api/connection-profiles/my-org-bindings — list org profiles where current user has bindings
  router.get("/my-org-bindings", async (c) => {
    const userId = c.get("user").id;
    const orgId = c.get("orgId");
    const profiles = await listOrgProfilesWithUserBindings(userId, orgId);
    return c.json({ profiles });
  });

  // ─── Org Profile Routes (before /:id to avoid param matching) ──

  // GET /api/connection-profiles/org — list org profiles
  router.get("/org", async (c) => {
    const orgId = c.get("orgId");
    const profiles = await listOrgProfiles(orgId);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles/org — create an org profile
  router.post("/org", rateLimit(10), requirePermission("org-profiles", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createOrgProfile(orgId, data.name.trim());
    return c.json({ profile }, 201);
  });

  // PUT /api/connection-profiles/org/:id — rename an org profile
  router.put("/org/:id", requirePermission("org-profiles", "write"), async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameOrgProfile(profileId, orgId, data.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename org profile", { profileId, orgId, error: message });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/connection-profiles/org/:id — delete an org profile
  router.delete("/org/:id", requirePermission("org-profiles", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    try {
      await deleteOrgProfile(profileId, orgId);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete org profile", { profileId, orgId, error: message });
      throw invalidRequest(message);
    }
  });

  // GET /api/connection-profiles/org/:id/agents — list agents using this org profile
  router.get("/org/:id/agents", async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    await requireOrgProfile(profileId, orgId);

    const rows = await db
      .select({
        id: packages.id,
        displayName: sql<string>`${packages.draftManifest}->>'displayName'`,
      })
      .from(applicationPackages)
      .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
      .where(eq(applicationPackages.orgProfileId, profileId));

    return c.json({ agents: rows });
  });

  // GET /api/connection-profiles/org/:id/bindings — list provider bindings for an org profile
  router.get("/org/:id/bindings", async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    await requireOrgProfile(profileId, orgId);
    const bindings = await getOrgProfileBindingsEnriched(profileId, orgId);
    return c.json({ bindings });
  });

  // POST /api/connection-profiles/org/:id/bind — bind a provider to a user's connection
  router.post(
    "/org/:id/bind",
    rateLimit(10),
    requirePermission("org-profiles", "bind"),
    async (c) => {
      const orgId = c.get("orgId");
      const userId = c.get("user").id;
      const profileId = c.req.param("id")!;
      await requireOrgProfile(profileId, orgId);

      const body = await c.req.json();
      const data = parseBody(
        z.object({
          providerId: z.string().min(1),
          sourceProfileId: z.uuid(),
        }),
        body,
      );

      // Verify source profile belongs to the requesting user
      const actor = getActor(c);
      const sourceProfile = await getProfileForActor(data.sourceProfileId, actor);
      if (!sourceProfile) {
        throw invalidRequest("Source profile not found or does not belong to you");
      }

      // Ownership check: can't overwrite another user's binding without org-profiles:write
      const existingOwner = await getBindingOwner(profileId, data.providerId);
      if (existingOwner && existingOwner !== userId) {
        const perms = c.get("permissions");
        if (!perms?.has("org-profiles:write")) {
          throw forbidden("Cannot overwrite a binding created by another member");
        }
      }

      // Verify the source profile has an active connection for this provider (any app)
      const connected = await hasActiveConnection(data.providerId, data.sourceProfileId, orgId);
      if (!connected) {
        throw invalidRequest(`No active connection for '${data.providerId}' on the source profile`);
      }

      await bindOrgProfileProvider(profileId, data.providerId, data.sourceProfileId, userId);
      return c.json({ bound: true });
    },
  );

  // DELETE /api/connection-profiles/org/:id/bind/:providerScope/:providerName — unbind a provider
  router.delete(
    "/org/:id/bind/:providerScope{@[^/]+}/:providerName",
    requirePermission("org-profiles", "bind"),
    async (c) => {
      const orgId = c.get("orgId");
      const userId = c.get("user").id;
      const profileId = c.req.param("id")!;
      const providerId = `${c.req.param("providerScope")}/${c.req.param("providerName")}`;
      await requireOrgProfile(profileId, orgId);

      // Ownership check: can't unbind another user's binding without org-profiles:write
      const existingOwner = await getBindingOwner(profileId, providerId);
      if (existingOwner && existingOwner !== userId) {
        const perms = c.get("permissions");
        if (!perms?.has("org-profiles:write")) {
          throw forbidden("Cannot unbind a connection bound by another member");
        }
      }

      await unbindOrgProfileProvider(profileId, providerId);
      return c.json({ unbound: true });
    },
  );

  // ─── User Profile Routes (/:id params after static routes) ──

  // PUT /api/connection-profiles/:id — rename a profile
  router.put("/:id", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameProfile(profileId, actor, data.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename profile", { profileId, actorId: actor.id, error: message });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/connection-profiles/:id — delete a profile
  router.delete("/:id", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    try {
      await deleteProfile(profileId, actor);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete profile", { profileId, actorId: actor.id, error: message });
      throw invalidRequest(message);
    }
  });

  // GET /api/connection-profiles/:id/connections — list connections for a profile
  // Optionally scoped by applicationId (from X-App-Id header or API key context).
  router.get("/:id/connections", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // Allow access if: own profile, org profile, or profile of another org member (read-only view)
    const profile =
      (await getProfileForActor(profileId, actor)) ??
      (await getOrgProfile(profileId, orgId)) ??
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
