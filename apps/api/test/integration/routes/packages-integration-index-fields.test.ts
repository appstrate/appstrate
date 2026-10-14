// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/packages/integrations` carries the two facts of `source` the
 * integration index splits and labels its list by — `source_kind` and the
 * local `server` — so the page draws itself from the index alone. Other types'
 * index rows carry neither.
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
      serverName: "@testorg/local-server",
      auths,
    }),
  );
  await seedActive(REMOTE, remoteIntegrationManifest({ name: REMOTE, auths }));
  await seedActive(API, apiIntegrationManifest({ name: API, auths }));
  await seedActive(SWITCHED_OFF, remoteIntegrationManifest({ name: SWITCHED_OFF, auths }), false);
});

describe("GET /api/packages/integrations — source facts", () => {
  it("names a local integration's kind and the server package it runs", async () => {
    const rows = await listIntegrations();
    expect(rows[LOCAL]).toMatchObject({
      source_kind: "local",
      server: { name: "@testorg/local-server", version: "^2.1.0" },
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

  it("leaves out an integration switched off in this space", async () => {
    const rows = await listIntegrations();
    expect(rows[SWITCHED_OFF]).toBeUndefined();
  });

  it("adds neither field to another type's index row", async () => {
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
  });
});
