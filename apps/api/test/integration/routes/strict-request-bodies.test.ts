// SPDX-License-Identifier: Apache-2.0

/**
 * Live half of the closed-request-body rule.
 *
 * `test/unit/strict-request-bodies.test.ts` sweeps every body schema the
 * OpenAPI Zod registry names — that is the standing, exhaustive guard, but it
 * reads schemas, not responses, and it cannot see the two MODULE route families
 * (their schemas are contributed at module-init time). These cases send real
 * requests, one per family, and pin the answer a client gets: a `400
 * validation_failed` whose `errors[]` names the unknown field, not a `200` that
 * silently dropped it.
 *
 * Every case carries its control — the same body minus the unknown key must
 * still succeed — so a refusal caused by anything else fails the pair.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import webhooksModule from "../../../src/modules/webhooks/index.ts";
import oidcModule from "../../../src/modules/oidc/index.ts";

const app = getTestApp({ modules: [webhooksModule, oidcModule] });

/** Assert the RFC 9457 shape a strict-schema refusal produces. */
async function expectUnknownField(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    code?: string;
    errors?: Array<{ code?: string }>;
  };
  expect(body.code).toBe("validation_failed");
  expect(body.errors?.some((e) => e.code === "unknown_field")).toBe(true);
}

describe("unknown request-body fields are refused, not stripped", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "strictbodies" });
  });

  // The case named in the audit: `generation_config` is the snake spelling a
  // client would reasonably guess, since `schedules.ts` spells the same concept
  // `generation_config_override`. It used to answer 200 and change nothing.
  it("spaces — PUT /api/spaces/{spaceId}/packages/{scope}/{name}", async () => {
    const packageId = "@strictbodies/pkg";
    await seedPackage({ id: packageId, orgId: ctx.orgId });
    await seedInstalledPackage(ctx.defaultSpaceId, packageId);

    const put = (body: Record<string, unknown>) =>
      app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${packageId}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await expectUnknownField(await put({ generation_config: { temperature: 0.4 } }));
    expect((await put({ enabled: false })).status).toBe(200);
  });

  it("proxies — POST /api/proxies", async () => {
    const post = (body: Record<string, unknown>) =>
      app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await expectUnknownField(
      await post({ label: "P", url: "http://proxy.example:8080", enabled: true }),
    );
    expect((await post({ label: "P", url: "http://proxy.example:8080" })).status).toBe(201);
  });

  it("organizations — POST /api/orgs", async () => {
    const post = (body: Record<string, unknown>) =>
      app.request("/api/orgs", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await expectUnknownField(await post({ name: "Acme", role: "owner" }));
    expect((await post({ name: "Acme" })).status).toBe(201);
  });

  // Module family 1 — the webhooks create body is a discriminated union, so
  // closedness has to hold on the BRANCH, not on the union node.
  it("webhooks module — POST /api/webhooks", async () => {
    const post = (body: Record<string, unknown>) =>
      app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const base = {
      level: "org",
      url: "https://hooks.example/endpoint",
      events: ["run.started"],
    };
    await expectUnknownField(await post({ ...base, secret: "not-a-field" }));
    expect((await post(base)).status).toBe(201);
  });

  // Module family 2 — per-space SMTP config.
  it("oidc module — PUT /api/spaces/{id}/smtp-config", async () => {
    const put = (body: Record<string, unknown>) =>
      app.request(`/api/spaces/${ctx.defaultSpaceId}/smtp-config`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const base = {
      host: "smtp.example.net",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "noreply@tenant.example",
    };
    await expectUnknownField(await put({ ...base, tls: true }));
    expect((await put(base)).status).toBe(200);
  });
});
