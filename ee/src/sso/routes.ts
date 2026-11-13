// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { Hono, type Context } from "hono";
import { z } from "zod";
import { readJsonBody } from "@appstrate/core/request-body";
import { requireModulePermission } from "@appstrate/core/permissions";
import { verificationRecordName, verificationRecordValue } from "./domain.ts";
import {
  addDomain,
  enforce,
  liftEnforcement,
  linkTenant,
  readSettings,
  removeDomain,
  setJoinRole,
  unlinkTenant,
  verifyDomain,
  type Actor,
  type SsoSettings,
} from "./service.ts";
import type { SsoDomain } from "./store.ts";
import { getPlatform } from "../platform.ts";

/** What the platform's auth and org middleware set before a module route runs. */
type SsoEnv = {
  Variables: {
    orgId: string;
    orgRole: string;
    user: { id: string; email: string; name: string };
    authMethod: string;
    sessionId?: string;
    permissions: ReadonlySet<string>;
  };
};

export const settingsPatchSchema = z.object({ join_role: z.enum(["member", "guest"]) }).strict();
export const linkTenantBodySchema = z.object({ replace: z.boolean().optional() }).strict();
export const domainBodySchema = z.object({ domain: z.string().min(1).max(253) }).strict();

function actorOf(c: Context<SsoEnv>): Actor {
  const orgId = c.get("orgId");
  return {
    orgId,
    userId: c.get("user").id,
    orgRole: c.get("orgRole"),
    authMethod: c.get("authMethod"),
    sessionId: c.get("sessionId"),
    audit: (entry) =>
      getPlatform().services.audit.record(c, {
        ...entry,
        resourceType: "org_sso",
        resourceId: orgId,
      }),
  };
}

function domainView(d: SsoDomain) {
  return {
    id: d.id,
    domain: d.domain,
    verified: d.verifiedAt !== null,
    verified_at: d.verifiedAt?.toISOString() ?? null,
    txt_record_name: verificationRecordName(d.domain),
    txt_record_value: verificationRecordValue(d.verificationToken),
    createdAt: d.createdAt.toISOString(),
  };
}

function settingsView(s: SsoSettings) {
  return {
    tenant_id: s.connection?.tenantId ?? null,
    tenant_linked_at: s.connection?.tenantLinkedAt?.toISOString() ?? null,
    join_role: s.connection?.joinRole ?? "member",
    enforced: s.connection?.enforcedAt != null,
    enforced_at: s.connection?.enforcedAt?.toISOString() ?? null,
    caller_tenant_id: s.callerTenantId,
    domains: s.domains.map(domainView),
  };
}

async function respondWithSettings(c: Context<SsoEnv>, status: 200 | 201 = 200) {
  const settings = await readSettings(c.get("orgId"), {
    userId: c.get("user").id,
    sessionId: c.get("sessionId"),
  });
  return c.json(settingsView(settings), status);
}

export function createSsoRouter() {
  const router = new Hono<SsoEnv>();
  const read = requireModulePermission("org-sso", "read");
  const write = requireModulePermission("org-sso", "write");

  router.get("/api/org-sso", read, (c) => respondWithSettings(c));

  router.patch("/api/org-sso", write, async (c) => {
    const body = await readJsonBody(c, settingsPatchSchema);
    await setJoinRole(actorOf(c), body.join_role);
    return respondWithSettings(c);
  });

  router.post("/api/org-sso/tenant", write, async (c) => {
    const body = await readJsonBody(c, linkTenantBodySchema, { allowEmpty: true });
    await linkTenant(actorOf(c), { replace: body.replace === true });
    return respondWithSettings(c);
  });

  router.delete("/api/org-sso/tenant", write, async (c) => {
    await unlinkTenant(actorOf(c));
    return respondWithSettings(c);
  });

  router.post("/api/org-sso/domains", write, async (c) => {
    const body = await readJsonBody(c, domainBodySchema);
    await addDomain(actorOf(c), body.domain);
    return respondWithSettings(c, 201);
  });

  router.post("/api/org-sso/domains/:domainId/verify", write, async (c) => {
    await verifyDomain(actorOf(c), c.req.param("domainId"));
    return respondWithSettings(c);
  });

  router.delete("/api/org-sso/domains/:domainId", write, async (c) => {
    await removeDomain(actorOf(c), c.req.param("domainId"));
    return respondWithSettings(c);
  });

  router.post("/api/org-sso/enforcement", write, async (c) => {
    await enforce(actorOf(c));
    return respondWithSettings(c);
  });

  router.delete("/api/org-sso/enforcement", write, async (c) => {
    await liftEnforcement(actorOf(c));
    return respondWithSettings(c);
  });

  return router;
}
