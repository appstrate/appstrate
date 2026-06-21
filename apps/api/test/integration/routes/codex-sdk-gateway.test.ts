// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Codex (ChatGPT) subscription credential vend —
 * `GET /api/llm-proxy/codex-sdk/:presetId`.
 *
 * The codex twin of `claude-code-sdk-gateway.test.ts`. Unlike the Claude path
 * this endpoint does NOT forward traffic — the official `codex` CLI talks to
 * chatgpt.com directly, so the gateway VENDS the resolved subscription
 * credential to the in-process first-party loopback caller.
 *
 * Pinned contract:
 *   1. FIRST-PARTY ONLY. An API key (even with `llm-proxy:call`) is refused 403;
 *      cookie sessions are refused too — a personal subscription is never
 *      vendable through a third-party-distributable credential.
 *   2. The preset MUST be a `codex` subscription model; any other provider is
 *      refused 400.
 *   3. An unresolvable preset (unknown / disabled / no usable credential) is
 *      refused 400.
 *   4. On the happy path the vend returns `{ access_token, account_id }` with the
 *      real resolved subscription token and `Cache-Control: no-store`.
 *   5. A reconnection-flagged credential is translated to a 401
 *      authentication_error (the 410→401 reconnection path), never a 410 leak.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedOrgModelProviderOAuth, seedOrgModel } from "../../helpers/seed.ts";
import { mintLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

interface Harness {
  ctx: TestContext;
  presetId: string;
  loopback: string;
}

async function buildCodexHarness(opts?: {
  providerId?: string;
  needsReconnection?: boolean;
  accessToken?: string;
}): Promise<Harness> {
  const ctx = await createTestContext({ orgSlug: `codex-${crypto.randomUUID().slice(0, 8)}` });
  const cred = await seedOrgModelProviderOAuth({
    orgId: ctx.orgId,
    providerId: opts?.providerId ?? "codex",
    accessToken: opts?.accessToken ?? "codex-REAL-SUBSCRIPTION",
    expiresAt: Date.now() + 3_600_000, // fresh → resolver returns it without refreshing
    needsReconnection: opts?.needsReconnection ?? false,
  });
  const model = await seedOrgModel({
    orgId: ctx.orgId,
    credentialId: cred.id,
    label: "Codex (sub)",
    modelId: "gpt-5.1-codex",
    enabled: true,
  });
  const loopback = mintLoopbackToken({
    userId: ctx.user.id,
    email: ctx.user.email ?? "u@test",
    name: ctx.user.name ?? "U",
    orgId: ctx.orgId,
    orgRole: "owner",
  });
  return { ctx, presetId: model.id, loopback };
}

function vendUrl(presetId: string): string {
  return `/api/llm-proxy/codex-sdk/${presetId}`;
}

describe("Codex SDK vend — first-party gating", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => flushRedis());

  it("refuses an API key with 403 (subscription never vendable via API key)", async () => {
    const h = await buildCodexHarness();
    const key = await seedApiKey({
      orgId: h.ctx.orgId,
      applicationId: h.ctx.defaultAppId,
      createdBy: h.ctx.user.id,
      scopes: ["llm-proxy:call"],
    });
    const res = await app.request(vendUrl(h.presetId), {
      method: "GET",
      headers: { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a cookie session with 403 (first-party loopback only)", async () => {
    const h = await buildCodexHarness();
    const res = await app.request(vendUrl(h.presetId), {
      method: "GET",
      headers: { Cookie: h.ctx.cookie, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(403);
  });
});

describe("Codex SDK vend — preset resolution", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => flushRedis());

  it("rejects a non-codex preset with 400 (no subscription vend for it)", async () => {
    const h = await buildCodexHarness({ providerId: "claude-code" });
    const res = await app.request(vendUrl(h.presetId), {
      method: "GET",
      headers: { Authorization: `Bearer ${h.loopback}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown / unresolvable preset with 400", async () => {
    const h = await buildCodexHarness();
    const res = await app.request(vendUrl(crypto.randomUUID()), {
      method: "GET",
      headers: { Authorization: `Bearer ${h.loopback}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(400);
  });
});

describe("Codex SDK vend — happy path + reconnection", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => flushRedis());

  it("vends { access_token, account_id } with the real token and no-store", async () => {
    const h = await buildCodexHarness({ accessToken: "codex-VENDED-TOKEN-XYZ" });
    const res = await app.request(vendUrl(h.presetId), {
      method: "GET",
      headers: { Authorization: `Bearer ${h.loopback}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { access_token: string; account_id: string | null };
    expect(body.access_token).toBe("codex-VENDED-TOKEN-XYZ");
    // No chatgpt_account_id on the seeded blob → vended as null (shape pinned).
    expect("account_id" in body).toBe(true);
    expect(body.account_id).toBeNull();
  });

  it("translates a reconnection-flagged credential into a 401 authentication_error", async () => {
    const h = await buildCodexHarness({ needsReconnection: true });
    const res = await app.request(vendUrl(h.presetId), {
      method: "GET",
      headers: { Authorization: `Bearer ${h.loopback}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toMatch(/[Rr]econnect/);
  });
});
