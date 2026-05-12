// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing-flow HTTP routes (POST/GET/DELETE /api/model-providers-oauth/pairing).
 *
 * The wrong-org reads/deletes return 404/204 (not 403) so a holder of an
 * arbitrary `pair_*` id cannot enumerate pairings belonging to other
 * tenants. This is a security invariant — adjust with care.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("POST /api/model-providers-oauth/pairing", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("returns 200 with a token + ready-to-paste npx command", async () => {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "test-oauth" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      token: string;
      command: string;
      expiresAt: string;
    };
    expect(body.id).toMatch(/^pair_[A-Za-z0-9_-]+$/);
    expect(body.token).toMatch(/^appp_/);
    expect(body.command).toBe(`npx @appstrate/connect-helper@latest ${body.token}`);
    // Date string must parse to a future timestamp.
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "test-oauth" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when providerId fails the regex", async () => {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "Bad!Id" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown registered providerId", async () => {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "nonexistent-provider" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/model-providers-oauth/pairing/:id", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  async function mint(): Promise<string> {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "test-oauth" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("returns status=pending for a freshly minted pairing", async () => {
    const id = await mint();
    const res = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; consumedAt: string | null };
    expect(body.status).toBe("pending");
    expect(body.consumedAt).toBeNull();
  });

  it("returns 404 when the pairing belongs to a different org (no enumeration)", async () => {
    const id = await mint();
    const otherCtx = await createTestContext({ orgSlug: "other-org" });
    const res = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      headers: authHeaders(otherCtx),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on malformed id (regex mismatch)", async () => {
    const res = await app.request("/api/model-providers-oauth/pairing/not-a-pair-id", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/model-providers-oauth/pairing/:id", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  async function mint(): Promise<string> {
    const res = await app.request("/api/model-providers-oauth/pairing", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ providerId: "test-oauth" }),
    });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("returns 204 and removes the row", async () => {
    const id = await mint();
    const del = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    const get = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      headers: authHeaders(ctx),
    });
    expect(get.status).toBe(404);
  });

  it("is idempotent — second DELETE still returns 204", async () => {
    const id = await mint();
    const first = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(first.status).toBe(204);
    const second = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(second.status).toBe(204);
  });

  it("wrong-org DELETE returns 204 (silent no-op, no enumeration)", async () => {
    const id = await mint();
    const otherCtx = await createTestContext({ orgSlug: "other-org-del" });
    const del = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      method: "DELETE",
      headers: authHeaders(otherCtx),
    });
    expect(del.status).toBe(204);

    // The original pairing is still there for the rightful owner.
    const get = await app.request(`/api/model-providers-oauth/pairing/${id}`, {
      headers: authHeaders(ctx),
    });
    expect(get.status).toBe(200);
  });
});
