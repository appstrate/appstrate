// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/packages/integrations` carries the two facts of `source` the
 * integration index splits and labels its list by — `source_kind` and the
 * local `server` (runtime + entry point) — so the page draws itself from the index alone, and
 * `authenticated`, false for an integration declaring no `auths` (it binds no connection). Other
 * types' index rows carry none of them.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import {
  apiIntegrationManifest,
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const LOCAL = "@testorg/local-integration";
const REMOTE = "@testorg/remote-integration";
const API = "@testorg/api-integration";
const SWITCHED_OFF = "@testorg/switched-off-integration";
const UNAUTHENTICATED = "@testorg/unauthenticated-integration";
const auths = { api: { type: "api_key" as const } };

let ctx: TestContext;

async function seedActive(id: string, manifest: unknown, enabled = true) {
  await seedPackage({
    id,
    orgId: ctx.orgId,
    type: "integration",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: manifest as Record<string, unknown>,
  });
  await seedSpacePackage(ctx.defaultSpaceId, id, { enabled });
}

async function listIntegrations(): Promise<Record<string, Record<string, unknown>>> {
  const res = await app.request("/api/packages/integrations", { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown>[] };
  return Object.fromEntries(body.data.map((row) => [row.id as string, row]));
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "testorg" });
  await seedActive(
    LOCAL,
    localIntegrationManifest({
      name: LOCAL,
      version: "2.1.0",
      server: { type: "node", entryPoint: "server/index.js" },
      auths,
    }),
  );
  await seedActive(REMOTE, remoteIntegrationManifest({ name: REMOTE, auths }));
  await seedActive(API, apiIntegrationManifest({ name: API, auths }));
  await seedActive(SWITCHED_OFF, remoteIntegrationManifest({ name: SWITCHED_OFF, auths }), false);
  // AFPS §7.2: an unauthenticated integration omits `auths` altogether.
  const { auths: _omitted, ...unauthenticated } = remoteIntegrationManifest({
    name: UNAUTHENTICATED,
    auths: {},
  }) as unknown as Record<string, unknown>;
  await seedActive(UNAUTHENTICATED, unauthenticated);
});

describe("GET /api/packages/integrations — source facts", () => {
  it("names a local integration's kind and the server it carries", async () => {
    const rows = await listIntegrations();
    expect(rows[LOCAL]).toMatchObject({
      source_kind: "local",
      server: { type: "node", entry_point: "server/index.js" },
    });
  });

  it("names a remote integration's kind, with no server", async () => {
    const rows = await listIntegrations();
    expect(rows[REMOTE]).toMatchObject({ source_kind: "remote", server: null });
  });

  it("names an integration with no MCP backing `none`, with no server", async () => {
    const rows = await listIntegrations();
    expect(rows[API]).toMatchObject({ source_kind: "none", server: null });
  });

  it("says an integration declaring `auths` is authenticated, one omitting them is not", async () => {
    const rows = await listIntegrations();
    expect(rows[REMOTE]).toMatchObject({ authenticated: true });
    expect(rows[LOCAL]).toMatchObject({ authenticated: true });
    expect(rows[UNAUTHENTICATED]).toMatchObject({ authenticated: false });
  });

  it("leaves out an integration switched off in this space", async () => {
    const rows = await listIntegrations();
    expect(rows[SWITCHED_OFF]).toBeUndefined();
  });

  it("adds none of these fields to another type's index row", async () => {
    await seedPackage({
      id: "@testorg/some-skill",
      orgId: ctx.orgId,
      type: "skill",
      homeSpaceId: ctx.defaultSpaceId,
    });
    await seedSpacePackage(ctx.defaultSpaceId, "@testorg/some-skill", { enabled: true });
    const res = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const skill = body.data.find((row) => row.id === "@testorg/some-skill");
    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty("source_kind");
    expect(skill).not.toHaveProperty("server");
    expect(skill).not.toHaveProperty("authenticated");
  });
});
