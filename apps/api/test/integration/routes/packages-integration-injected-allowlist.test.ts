// SPDX-License-Identifier: Apache-2.0

/**
 * An auth that injects a credential over HTTP must bound its hosts (#1641): every path that
 * writes an integration manifest refuses `allow_all_uris` or a host-unbounded `authorized_uris`
 * entry on it (`CONFIG_BY_TYPE.checkManifest`), and accepts an auth the proxy injects nothing for.
 */

import { etagVersion, ifMatch } from "../../helpers/etag.ts";
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages } from "@appstrate/db/schema";
import { apiIntegrationManifest, envDelivery } from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const ID = "@alloworg/api";

function manifest(auth: {
  type: "api_key" | "custom";
  authorizedUris?: string[];
  allowAll?: true;
}) {
  return apiIntegrationManifest({
    name: ID,
    auths: {
      api: {
        type: auth.type,
        ...(auth.authorizedUris ? { authorizedUris: auth.authorizedUris } : {}),
        ...(auth.allowAll ? { allowAllUris: true } : {}),
        ...(auth.type === "custom" ? { delivery: envDelivery({ TOKEN: "api_key" }) } : {}),
      },
    },
  }) as unknown as Record<string, unknown>;
}

interface ProblemBody {
  errors?: { field?: string; code?: string }[];
}

async function expectRefused(res: Response, field: string) {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ProblemBody;
  expect(body.errors?.[0]).toMatchObject({ field, code: "invalid_manifest" });
}

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "alloworg" });
});

function create(m: Record<string, unknown>) {
  return app.request("/api/packages/integrations", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: m }),
  });
}

describe("writing an injecting auth's allowlist", () => {
  it("create refuses allow_all_uris and writes nothing", async () => {
    await expectRefused(
      await create(manifest({ type: "api_key", allowAll: true })),
      "manifest.auths.api.allow_all_uris",
    );
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  it("create accepts allow_all_uris on an auth the proxy injects nothing for", async () => {
    expect((await create(manifest({ type: "custom", allowAll: true }))).status).toBe(201);
  });

  it("draft save refuses a host-unbounded entry and leaves the draft untouched", async () => {
    const created = await create(manifest({ type: "api_key" }));
    expect(created.status).toBe(201);
    const res = await app.request(`/api/packages/integrations/${ID}`, {
      method: "PATCH",
      headers: authHeaders(ctx, {
        "Content-Type": "application/json",
        ...ifMatch(etagVersion(created)),
      }),
      body: JSON.stringify({
        manifest: manifest({ type: "api_key", authorizedUris: ["https://**"] }),
      }),
    });
    await expectRefused(res, "manifest.auths.api.authorized_uris.0");
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, ID));
    expect(row?.draftManifest).toMatchObject({
      auths: { api: { authorized_uris: ["https://api.example.com/**"] } },
    });
  });
});
