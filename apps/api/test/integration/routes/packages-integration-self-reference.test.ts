// SPDX-License-Identifier: Apache-2.0

/**
 * An integration's `source.server.name` names the `mcp-server` package it runs.
 * Naming the integration ITSELF can never resolve, so the write paths refuse it
 * rather than store a package that fails every run with `mcp_server_unresolved`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages } from "@appstrate/db/schema";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";

const app = getTestApp();
const ID = "@selforg/loop";

function manifest(serverName: string) {
  return {
    ...apiIntegrationManifest({ name: ID, auths: { api: { type: "api_key" } } }),
    source: { kind: "local", server: { name: serverName, version: "^1.0.0" } },
  };
}

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "selforg" });
});

function create(m: Record<string, unknown>) {
  return app.request("/api/packages/integrations", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: m }),
  });
}

describe("an integration naming itself as its mcp-server", () => {
  it("is refused at create, naming the field, and writes nothing", async () => {
    const res = await create(manifest(ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { field?: string; code?: string }[] };
    expect(body.errors?.[0]).toMatchObject({
      field: "manifest.source.server.name",
      code: "invalid_manifest",
    });
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  it("naming another package is accepted", async () => {
    expect((await create(manifest("@selforg/server"))).status).toBe(201);
  });
});
