// SPDX-License-Identifier: Apache-2.0

/**
 * Admin routes — `/api/spaces/:id/smtp-config[/test]`.
 * Smoke tests for CRUD + SSRF block + pass redaction.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedSpace, seedSpaceMember } from "../../../../../../test/helpers/seed.ts";
import oidcModule from "../../../index.ts";
import { _clearSmtpCacheForTesting } from "../../../services/smtp.ts";

const app = getTestApp({ modules: [oidcModule] });

describe("/api/spaces/:id/smtp-config", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    _clearSmtpCacheForTesting();
    ctx = await createTestContext({ orgSlug: "smtp-admin" });
  });

  it("PUT creates, GET returns without pass, DELETE removes", async () => {
    const putRes = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "smtp.sendgrid.net",
        port: 587,
        username: "apikey",
        pass: "super-secret-pass",
        fromAddress: "noreply@tenant.example",
        fromName: "Tenant",
      }),
    });
    expect(putRes.status).toBe(200);
    const created = (await putRes.json()) as Record<string, unknown>;
    expect(created.host).toBe("smtp.sendgrid.net");
    expect(created).not.toHaveProperty("pass");
    expect(created).not.toHaveProperty("passEncrypted");

    const getRes = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      headers: authHeaders(ctx),
    });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(got.host).toBe("smtp.sendgrid.net");
    expect(got).not.toHaveProperty("pass");

    const delRes = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(delRes.status).toBe(204);

    const notFound = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      headers: authHeaders(ctx),
    });
    expect(notFound.status).toBe(404);
  });

  it("rejects SSRF hosts", async () => {
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "169.254.169.254",
        port: 25,
        username: "u",
        pass: "p",
        fromAddress: "evil@tenant.example",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a space that does not belong to the caller's org", async () => {
    const res = await app.request(`/api/spaces/spc_${crypto.randomUUID()}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "smtp.sendgrid.net",
        port: 587,
        username: "u",
        pass: "p",
        fromAddress: "a@b.c",
      }),
    });
    expect(res.status).toBe(404);
  });

  // These routes ran their own space-ownership SELECT with NO id-shape guard,
  // so a wrong-prefix id answered a generic 404 — indistinguishable from "that
  // space is not yours". They now go through the canonical
  // `validateSpaceInOrg`, which asserts the shape first: a 400 on shape, before
  // any lookup.
  it("400s on shape for a wrong-prefix id, rather than 404ing from the lookup", async () => {
    const res = await app.request(`/api/spaces/app_${crypto.randomUUID()}/smtp-config`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Malformed space id");
  });

  it("400s for a malformed space id", async () => {
    const res = await app.request(`/api/spaces/spc_doesnotexist/smtp-config`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Malformed space id");
  });

  it("POST /test delivers via the stored config (jsonTransport)", async () => {
    await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "__test_json__",
        port: 587,
        username: "u",
        pass: "p",
        fromAddress: "noreply@tenant.example",
      }),
    });

    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config/test`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ to: "admin@tenant.example" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

/**
 * #1337 — the SMTP routes were gated on the ORG-level `spaces:read` /
 * `spaces:write`, strings every `member` and `guest` holds for the whole org,
 * with the only space check being "does this space belong to my org". They now
 * enter the space named by `:id` and require the SPACE-level
 * `space-settings:write` there, so the answer depends on membership.
 */
describe("/api/spaces/:id/smtp-config — space membership gate", () => {
  let ctx: TestContext;
  let privateSpaceId: string;

  beforeEach(async () => {
    await truncateAll();
    _clearSmtpCacheForTesting();
    ctx = await createTestContext({ orgSlug: "smtp-gate" });
    const space = await seedSpace({
      orgId: ctx.orgId,
      name: "Private",
      visibility: "private",
      createdBy: ctx.user.id,
    });
    privateSpaceId = space.id;

    // The org owner administers every space, so seeding through the route
    // also proves the owner path is untouched by the new gate.
    const seeded = await app.request(`/api/spaces/${privateSpaceId}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "smtp.sendgrid.net",
        port: 587,
        username: "apikey",
        pass: "super-secret-pass",
        fromAddress: "noreply@tenant.example",
      }),
    });
    expect(seeded.status).toBe(200);
  });

  it("404s a guest on a private space it is not in — the config never leaks", async () => {
    const guest = await memberContext(ctx, "guest");
    const res = await app.request(`/api/spaces/${privateSpaceId}/smtp-config`, {
      headers: authHeaders(guest),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("smtp.sendgrid.net");
  });

  it("403s a guest on an open space it is not in", async () => {
    const guest = await memberContext(ctx, "guest");
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      headers: authHeaders(guest),
    });
    expect(res.status).toBe(403);
  });

  it("403s a member of the space that does not administer it", async () => {
    const viewer = await memberContext(ctx, "member", "viewer");
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      headers: authHeaders(viewer),
    });
    expect(res.status).toBe(403);
  });

  it("serves the space's own admin, whatever their org role", async () => {
    const spaceAdmin = await memberContext(ctx, "guest");
    await seedSpaceMember({
      spaceId: privateSpaceId,
      userId: spaceAdmin.user.id,
      presetRole: "admin",
    });
    const res = await app.request(`/api/spaces/${privateSpaceId}/smtp-config`, {
      headers: authHeaders(spaceAdmin),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.host).toBe("smtp.sendgrid.net");
    expect(body).not.toHaveProperty("pass");
  });

  it("refuses a guest's write the same way", async () => {
    const guest = await memberContext(ctx, "guest");
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
      method: "PUT",
      headers: { ...authHeaders(guest), "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "smtp.attacker.example",
        port: 587,
        username: "u",
        pass: "p",
        fromAddress: "a@b.c",
      }),
    });
    expect(res.status).toBe(403);
  });
});
