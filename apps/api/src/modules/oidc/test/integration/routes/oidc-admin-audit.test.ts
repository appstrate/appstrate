// SPDX-License-Identifier: Apache-2.0

/**
 * Audit trail of the OIDC admin mutations — OAuth clients (incl. secret
 * rotation), per-space SMTP and social providers. Each writes one
 * `audit_events` row, and no row ever carries a secret.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { auditEvents } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { _clearSmtpCacheForTesting } from "../../../services/smtp.ts";
import { _clearSocialCacheForTesting } from "../../../services/social.ts";

const app = getTestApp({ modules: [oidcModule] });

describe("OIDC admin audit trail", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    _clearSmtpCacheForTesting();
    _clearSocialCacheForTesting();
    ctx = await createTestContext({ orgSlug: "oidc-audit" });
  });

  function send(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function auditRows() {
    return db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.orgId, ctx.orgId))
      .orderBy(asc(auditEvents.id));
  }

  it("records OAuth client create, update, secret rotation and delete", async () => {
    const created = await send("POST", "/api/oauth/clients", {
      level: "space",
      name: "Acme Portal",
      redirectUris: ["https://acme.example.com/oauth/callback"],
      referencedSpaceId: ctx.defaultSpaceId,
    });
    expect(created.status).toBe(201);
    const { clientId, clientSecret } = (await created.json()) as {
      clientId: string;
      clientSecret: string;
    };

    expect((await send("PATCH", `/api/oauth/clients/${clientId}`, { disabled: true })).status).toBe(
      200,
    );
    const rotated = await send("POST", `/api/oauth/clients/${clientId}/rotate`);
    expect(rotated.status).toBe(200);
    const { clientSecret: rotatedSecret } = (await rotated.json()) as { clientSecret: string };
    expect((await send("DELETE", `/api/oauth/clients/${clientId}`)).status).toBe(204);

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.resourceType, r.resourceId, r.actorId])).toEqual([
      ["oauth_client.created", "oauth_client", clientId, ctx.user.id],
      ["oauth_client.updated", "oauth_client", clientId, ctx.user.id],
      ["oauth_client.secret_rotated", "oauth_client", clientId, ctx.user.id],
      ["oauth_client.deleted", "oauth_client", clientId, ctx.user.id],
    ]);
    expect(rows[1]!.after).toEqual({ disabled: true });
    const trail = JSON.stringify(rows);
    expect(trail).not.toContain(clientSecret);
    expect(trail).not.toContain(rotatedSecret);
  });

  it("records SMTP set/delete without the password or username", async () => {
    const path = `/api/spaces/${ctx.defaultSpaceId}/smtp-config`;
    const put = await send("PUT", path, {
      host: "smtp.sendgrid.net",
      port: 587,
      username: "smtp-user-name",
      pass: "super-secret-pass",
      from_address: "noreply@tenant.example",
    });
    expect(put.status).toBe(200);
    expect((await send("DELETE", path)).status).toBe(204);

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.resourceId, r.spaceId])).toEqual([
      ["space.smtp_config.set", ctx.defaultSpaceId, ctx.defaultSpaceId],
      ["space.smtp_config.deleted", ctx.defaultSpaceId, ctx.defaultSpaceId],
    ]);
    expect(rows[0]!.after).toEqual({
      host: "smtp.sendgrid.net",
      port: 587,
      fromAddress: "noreply@tenant.example",
    });
    const trail = JSON.stringify(rows);
    expect(trail).not.toContain("super-secret-pass");
    expect(trail).not.toContain("smtp-user-name");
  });

  it("records social-provider set/delete without the client secret", async () => {
    const path = `/api/spaces/${ctx.defaultSpaceId}/social-providers/google`;
    const put = await send("PUT", path, {
      client_id: "tenant.apps.googleusercontent.com",
      client_secret: "super-secret",
    });
    expect(put.status).toBe(200);
    expect((await send("DELETE", path)).status).toBe(204);

    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.resourceType, r.resourceId])).toEqual([
      ["space.social_provider.set", "social_provider", "google"],
      ["space.social_provider.deleted", "social_provider", "google"],
    ]);
    expect(rows[0]!.after).toEqual({ clientId: "tenant.apps.googleusercontent.com", scopes: null });
    expect(JSON.stringify(rows)).not.toContain("super-secret");
  });
});
