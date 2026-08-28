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
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
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
  // so a retired `app_` id answered a generic 404 — indistinguishable from
  // "that space is not yours", and silent about the real cause. They now go
  // through the canonical `validateSpaceInOrg`, which asserts the shape first.
  it("400s with the migration diagnostic for a retired `app_` id", async () => {
    const res = await app.request(`/api/spaces/app_${crypto.randomUUID()}/smtp-config`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("app_` → `spc_");
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
