// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/packages/integrations` with `publish: false`: the draft is created and activated in
 * its home space with no version, so it can be connected and synchronized from its server through
 * the draft before its first version is published. The default still publishes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersions, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server.ts";

const TOKEN = "tok-live-123";
const ID = "@acme/docs";

let server: FakeMcpServer;
let restoreEgress: () => void;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = startFakeMcpServer({
    tools: [{ name: "search", annotations: { readOnlyHint: true } }, "update"],
    bearer: TOKEN,
  });
});

afterAll(() => {
  server.stop();
  restoreEgress();
});

const manifest = (version = "1.0.0") =>
  remoteIntegrationManifest({
    name: ID,
    version,
    url: server.url,
    auths: {
      api_key: {
        type: "api_key",
        authorizedUris: [`${server.origin}/**`],
        credentialFields: ["token"],
        requiredCredentialFields: ["token"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.token}",
          },
        },
      },
    },
  });

describe("POST /api/packages/integrations — publish: false", () => {
  let ctx: TestContext;
  const json = (ctx: TestContext) => ({ ...authHeaders(ctx), "Content-Type": "application/json" });
  const create = (body: Record<string, unknown>) =>
    getTestApp().request("/api/packages/integrations", {
      method: "POST",
      headers: json(ctx),
      body: JSON.stringify(body),
    });
  const versionCount = async () =>
    (await db.select().from(packageVersions).where(eq(packageVersions.packageId, ID))).length;
  const placement = async () =>
    (
      await db
        .select()
        .from(spacePackages)
        .where(and(eq(spacePackages.packageId, ID), eq(spacePackages.spaceId, ctx.defaultSpaceId)))
    )[0];

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
    server.methods.length = 0;
  });

  it("creates the draft with no version, activated in its home, connectable and synchronizable", async () => {
    const res = await create({ manifest: manifest(), publish: false });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version_count: number }).version_count).toBe(0);
    expect(await versionCount()).toBe(0);
    expect((await placement())?.enabled).toBe(true);

    const detail = await getTestApp().request(`/api/integrations/${ID}`, {
      headers: authHeaders(ctx),
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { active: boolean }).active).toBe(true);

    const connected = await getTestApp().request(
      `/api/integrations/${ID}/auths/api_key/connect/fields`,
      {
        method: "POST",
        headers: json(ctx),
        body: JSON.stringify({ credentials: { token: TOKEN } }),
      },
    );
    expect(connected.status).toBe(200);

    const sync = await getTestApp().request(`/api/integrations/${ID}/discover`, {
      method: "POST",
      headers: json(ctx),
      body: "{}",
    });
    expect(sync.status).toBe(200);
    const proposal = (await sync.json()) as { tools: { name: string }[] };
    expect(proposal.tools.map((tool) => tool.name)).toEqual(["search", "update"]);
    // Synchronizing published nothing either.
    expect(await versionCount()).toBe(0);
  });

  it("publishes and activates by default", async () => {
    const res = await create({ manifest: manifest() });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version_count: number }).version_count).toBe(1);
    expect(await versionCount()).toBe(1);
    expect((await placement())?.enabled).toBe(true);
  });

  it("validates the manifest exactly as a publishing create does", async () => {
    for (const bad of ["not-semver", ""]) {
      const res = await create({ manifest: manifest(bad), publish: false });
      expect(res.status).toBe(400);
    }
    const { version: _version, ...noVersion } = manifest();
    expect((await create({ manifest: noVersion, publish: false })).status).toBe(400);
    expect(await versionCount()).toBe(0);
  });

  it("refuses a non-boolean publish", async () => {
    expect((await create({ manifest: manifest(), publish: "no" })).status).toBe(400);
  });

  it("is refused on a type whose create always publishes", async () => {
    const res = await getTestApp().request("/api/packages/skills", {
      method: "POST",
      headers: json(ctx),
      body: JSON.stringify({
        manifest: { name: "@acme/s", version: "1.0.0", type: "skill" },
        content: "---\nname: s\ndescription: d\n---\n",
        publish: false,
      }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("publish");
  });
});
